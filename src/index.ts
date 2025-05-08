import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OpenAI from "openai";
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { zodResponseFormat } from "openai/helpers/zod.mjs";


// Environment variables need to be defined in the Cloudflare dashboard or via the CLI (secrets)
// Define environment variable interface for type safety
interface InkeepEnv extends Env {
	INKEEP_API_BASE_URL: string;
	INKEEP_API_KEY: string;
	INKEEP_API_MODEL: string;
	INKEEP_PRODUCT_SLUG: string;
	INKEEP_PRODUCT_NAME: string;
}

// Interface matching the Python response structure
const InkeepRAGDocumentSchema = z.object({
	// anthropic fields citation types
	type: z.string(),
	source: z.record(z.any()),
	title: z.string().optional().nullable(),
	context: z.string().optional().nullable(),
	// inkeep specific fields
	record_type: z.string().optional().nullable(),
	url: z.string().optional().nullable(),
});

const InkeepRAGResponseSchema = z.object({
	content: z.array(InkeepRAGDocumentSchema),
});

type InkeepRAGDocument = z.infer<typeof InkeepRAGDocumentSchema>;
type InkeepRAGResponse = z.infer<typeof InkeepRAGResponseSchema>;

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Inkeep MCP Server",
		version: "1.0.0",
	});

	private static env: InkeepEnv;

	static configure(env: InkeepEnv) {
		MyMCP.env = env;
		return MyMCP;
	}

	async init() {
		// Get product information from environment variables
		const productSlug = MyMCP.env.INKEEP_PRODUCT_SLUG || "inkeep";
		const productName = MyMCP.env.INKEEP_PRODUCT_NAME || "Inkeep";

		// Create tool names and descriptions with parameters
		const ragToolName = `search-${productSlug}-docs`;
		const ragToolDescription = `Use this tool to do a semantic search for reference content related to ${productName}. The results provided will be extracts from documentation sites and other public sources like GitHub. The content may not fully answer your question -- be circumspect when reviewing and interpreting these extracts before using them in your response.`;

		const qaToolName = `ask-question-about-${productSlug}`;
		const qaToolDescription = `Use this tool to ask a question about ${productName} to an AI Support Agent that is knowledgeable about ${productName}. Use this tool to ask specific troubleshooting, feature capability, or conceptual questions. Be specific and provide the minimum context needed to address your question in full`;

		// Define RAG tool (documentation search)
		const ragTool = this.server.tool(
			ragToolName,
			{
				query: z.string().describe("The search query to find relevant documentation"),
			},
			async (args, extra) => {
				try {
					const query = args.query;

					// Retrieve settings from environment variables
					const apiBaseUrl = MyMCP.env.INKEEP_API_BASE_URL || "https://api.inkeep.com/v1";
					const apiKey = MyMCP.env.INKEEP_API_KEY;
					const apiModel = "inkeep-rag";

					if (!apiKey) {
						console.error("Inkeep API key not provided");
						return { content: [] };
					}

					const openai = new OpenAI({
						baseURL: apiBaseUrl,
						apiKey: apiKey,
					});

					const response = await openai.beta.chat.completions.parse({
						model: "inkeep-rag",
						messages: [{ role: "user", content: query }],
						response_format: zodResponseFormat(InkeepRAGResponseSchema, "InkeepRAGResponseSchema"),
					});

					// Transform InkeepRAGDocuments to MCP-compatible format
					const formattedContent = response.choices[0].message.parsed?.content.map(doc => {
						// Extract text from the source when possible
						let text = "";

						if (typeof doc.source === "object" && doc.source) {
							// Try to extract text from common source formats
							if (Array.isArray(doc.source.content) && doc.source.content.length > 0) {
								// Join all text content if available
								text = doc.source.content
									.filter(item => item.text)
									.map(item => item.text)
									.join("\n");
							} else if (typeof doc.source.text === "string") {
								text = doc.source.text;
							} else {
								// Fallback to stringifying the source
								text = JSON.stringify(doc.source);
							}
						} else {
							text = JSON.stringify(doc.source);
						}

						// Return a properly formatted text item for MCP
						return {
							type: "text" as const,
							text: text || "No content available",
						};
					}) || [];

					return { content: formattedContent };
				} catch (error) {
					console.error("Error retrieving product docs:", error);
					return { content: [] };
				}
			},
		);

		// Define QA tool (AI support agent)
		const qaTool = this.server.tool(
			qaToolName,
			{
				question: z.string().describe("The specific question about the product"),
			},
			async (args, extra) => {
				try {
					const question = args.question;

					// Retrieve settings from environment variables
					const apiBaseUrl = MyMCP.env.INKEEP_API_BASE_URL || "https://api.inkeep.com/v1";
					const apiKey = MyMCP.env.INKEEP_API_KEY;
					const apiModel = "inkeep-qa-expert";

					if (!apiKey) {
						console.error("Inkeep API key not provided");
						return { content: [] };
					}

					// Create OpenAI client fromSDK with Inkeep API settings
					const openai = new OpenAI({
						baseURL: apiBaseUrl,
						apiKey: apiKey,
					});

					const response = await openai.chat.completions.create({
						model: apiModel,
						messages: [
							{ role: "user", content: question },
						],
					});

					// Get the response content
					const qaResponse = response.choices?.[0]?.message?.content;

					if (qaResponse) {
						return {
							content: [
								{
									type: "text" as const,
									text: qaResponse,
								},
							],
						};
					}

					// If no response, return empty array
					return { content: [] };
				} catch (error) {
					console.error("Error getting QA response:", error);
					return { content: [] };
				}
			},
		);

		// Add annotations to the RAG tool
		ragTool.update({
			description: ragToolDescription,
			annotations: {
				title: `Search ${productName} Documentation`,
				readOnlyHint: true,
				openWorldHint: true,
			},
		});

		// Add annotations to the QA tool
		qaTool.update({
			description: qaToolDescription,
			annotations: {
				title: `Ask AI about ${productName}`,
				readOnlyHint: true,
				openWorldHint: true,
			},
		});
	}
}

export default {
	fetch(request: Request, env: InkeepEnv, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			// @ts-ignore
			return MyMCP.configure(env).serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			// @ts-ignore
			return MyMCP.configure(env).serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
