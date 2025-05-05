import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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

interface InkeepRAGResponse {
	content: InkeepRAGDocument[];
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

	async init() {
		// Define a single tool that invokes the Inkeep RAG API
		this.server.tool(
			"search-product-content",
			{ query: z.string() },
			async ({ query }: { query: string }, env: InkeepEnv) => {
				try {
					// Retrieve settings from environment variables
					const apiBaseUrl = env.INKEEP_API_BASE_URL || "https://api.inkeep.com/v1";
					const apiKey = env.INKEEP_API_KEY;
					const apiModel = env.INKEEP_API_MODEL || "inkeep-rag";

					if (!apiKey) {
						console.error("Inkeep API key not provided");
						return { content: [] };
					}

					// Make request to Inkeep API
					const response = await fetch(`${apiBaseUrl}/chat/completions`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Authorization": `Bearer ${apiKey}`
						},
						body: JSON.stringify({
							model: apiModel,
							messages: [
								{ role: "user", content: query }
							]
						})
					});

					if (!response.ok) {
						const errorText = await response.text();
						console.error(`Inkeep API error: ${response.status} ${errorText}`);
						return { content: [] };
					}

					const data = await response.json() as APIResponse;
					
					// Parse the response to extract documents
					// The exact structure may need adjustment based on the actual Inkeep API response
					const inkeepResponse = data.choices?.[0]?.message?.content;
					
					if (inkeepResponse && Array.isArray(inkeepResponse)) {
						return { content: inkeepResponse as InkeepRAGDocument[] };
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
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			// @ts-ignore
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			// @ts-ignore
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
