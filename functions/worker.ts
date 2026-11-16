import { onRequest } from "./api/[[route]].ts";

interface WorkerEnv {
  ASSETS?: {
    fetch: (request: Request | string) => Promise<Response>;
  };
  DEEPSEEK_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  AI_PRIMARY_PROVIDER?: string;
  DISABLE_CLOUD_AI?: string;
  [key: string]: unknown;
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const route = url.pathname.replace(/^\/api\/?/, "");
      const apiRes = await onRequest({
        request,
        env: env as unknown as Record<string, string | undefined>,
        params: { route },
      });
      return withSecurityHeaders(apiRes);
    }

    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      return withSecurityHeaders(assetRes);
    }

    return withSecurityHeaders(new Response("Not Found", { status: 404 }));
  },
};
