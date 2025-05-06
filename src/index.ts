import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OpenAI from 'openai';


// Environment variables need to be defined in the Cloudflare dashboard or via the CLI (secrets)
// Define environment variable interface for type safety
interface InkeepEnv extends Env {
	INKEEP_API_BASE_URL: string;
	INKEEP_API_KEY: string;
	INKEEP_API_MODEL: string;
}

// Interface matching the Python response structure
interface InkeepRAGDocument {
	type: string;
	source: {
		type: string;
		media_type?: string;
		data?: string;
		content?: Array<{ type: string; text: string }>;
	};
	title?: string;
	context?: string;
	record_type?: string;
	url?: string;
}

// OpenAI-like response interface
interface APIResponse {
	choices?: Array<{
		message?: {
			content?: unknown;
		};
	}>;
}

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
		// Define a single tool that invokes the Inkeep RAG API using the correct signature
		this.server.tool(
			"search-product-content", 
			{
				query: z.string().describe("The search query to find relevant documentation"),
			},
			async (args) => {
				try {
					const query = args.query;
					
					// Retrieve settings from environment variables
					const apiBaseUrl = MyMCP.env.INKEEP_API_BASE_URL || "https://api.inkeep.com/v1";
					const apiKey = MyMCP.env.INKEEP_API_KEY;
					const apiModel = MyMCP.env.INKEEP_API_MODEL || "inkeep-rag";
					
					if (!apiKey) {
						console.error("Inkeep API key not provided");
						return { content: [] };
					}

					// Create OpenAI client from Vercel AI SDK with Inkeep API settings
					const openai = new OpenAI({
						baseURL: apiBaseUrl,
						apiKey: apiKey,
					});
					
					// Make request to Inkeep API using Vercel AI SDK
					const response = await openai.chat.completions.create({
						model: apiModel,
						messages: [
							{ role: "user", content: query }
						],
					});

					// Parse the response to extract documents
					const inkeepResponse = response.choices?.[0]?.message?.content;
					
					if (inkeepResponse) {
						try {
							// Try to parse the content if it's a JSON string
							const parsedContent = typeof inkeepResponse === 'string' 
								? JSON.parse(inkeepResponse) 
								: inkeepResponse;
							
							if (Array.isArray(parsedContent.content)) {
								// Transform InkeepRAGDocuments to the format expected by MCP Server
								const formattedContent = (parsedContent.content as InkeepRAGDocument[]).map(doc => {
									return {
										type: "text" as const,
										text: `${doc.title ? `${doc.title}\n\n` : ''}${doc.source.data || ''}${doc.url ? `\n\nSource: ${doc.url}` : ''}`
									};
								});
								
								return { content: formattedContent };
							}
						} catch (parseError) {
							console.error("Error parsing Inkeep response:", parseError);
						}
					}
					
					// If we can't extract documents, return empty array
					return { content: [] };
				} catch (error) {
					console.error("Error retrieving product docs:", error);
					return { content: [] };
				}
			}
		);
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
