/**
 * Vantiq REST API Service
 *
 * Thin fetch wrapper for the Vantiq REST API. Import the singleton and call
 * its methods directly — token management is handled by AuthContext, never
 * by callers. See the `rest-api` doc on the vantiq-vite MCP server for the
 * full protocol reference.
 *
 * Usage:
 *   import Vantiq from './services/vantiq'
 *   const results = await Vantiq.select('MyType', { where: {...}, limit: 10 })
 */

class VantiqAPI {
  constructor() {
    // Same-origin builds use relative URLs (no absolute server URL needed):
    //   - dev: requests go through Vite's proxy (avoids CORS)
    //   - vantiq: the app is hosted ON Vantiq, so it's same-origin with the API
    // Only a build hosted elsewhere needs the absolute VITE_VANTIQ_URL.
    const sameOrigin = import.meta.env.DEV || import.meta.env.MODE === "vantiq";
    if (!sameOrigin && !import.meta.env.VITE_VANTIQ_URL) {
      throw new Error("Missing required env var: VITE_VANTIQ_URL — add it to .env.local");
    }
    if (!import.meta.env.VITE_VANTIQ_NAMESPACE) {
      throw new Error("Missing required env var: VITE_VANTIQ_NAMESPACE — add it to .env.local");
    }
    this.baseUrl = sameOrigin ? "" : import.meta.env.VITE_VANTIQ_URL;
    this.namespace = import.meta.env.VITE_VANTIQ_NAMESPACE;
    this.accessToken = null;
    this.tokenProvider = null;
  }

  async parseErrorResponse(response) {
    // Read the body once — a Response body is single-use, so parse-then-
    // fall-back-to-text on the SAME read rather than trying json() then text().
    const raw = await response.text().catch(() => "");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (typeof parsed === "string") return parsed;
    if (parsed?.message) return parsed.message;
    if (parsed?.error) {
      return typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
    }
    if (Array.isArray(parsed) && parsed.length > 0) return JSON.stringify(parsed[0]);
    return JSON.stringify(parsed);
  }

  /** Set the access token for authenticated requests. Called by AuthContext only. */
  setAccessToken(token) {
    this.accessToken = token;
  }

  /**
   * Register an async token provider, called before each request to refresh
   * the token if needed. A provider throw never blocks the request — it
   * proceeds with whatever token is currently set.
   */
  setTokenProvider(fn) {
    this.tokenProvider = fn;
  }

  async ensureFreshToken() {
    if (!this.tokenProvider) return;
    try {
      const token = await this.tokenProvider();
      if (token) this.setAccessToken(token);
    } catch {
      // proceed with the current token
    }
  }

  setNamespace(namespace) {
    this.namespace = namespace;
  }

  getHeaders(namespace) {
    const headers = { "Content-Type": "application/json" };
    if (this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;
    const targetNamespace = namespace || this.namespace;
    if (targetNamespace) headers["X-Target-Namespace"] = targetNamespace;
    return headers;
  }

  buildQueryString(params) {
    const parts = [];
    if (params.where) parts.push(`where=${encodeURIComponent(JSON.stringify(params.where))}`);
    if (params.sort) parts.push(`sort=${encodeURIComponent(JSON.stringify(params.sort))}`);
    if (params.props) parts.push(`props=${encodeURIComponent(JSON.stringify(params.props))}`);
    if (params.page) parts.push(`page=${params.page}`);
    if (params.limit) parts.push(`limit=${params.limit}`);
    if (params.count === true || params.count === "true") parts.push(`count=true`);
    return parts.length > 0 ? `?${parts.join("&")}` : "";
  }

  /**
   * SELECT — query matching instances of a resource type.
   * options: { where, sort, props, page, limit, count, namespace }
   */
  async select(resourceType, options = {}) {
    const { namespace, ...queryParams } = options;
    const url = `${this.baseUrl}/api/v1/resources/${resourceType}${this.buildQueryString(queryParams)}`;
    await this.ensureFreshToken();
    const response = await fetch(url, { method: "GET", headers: this.getHeaders(namespace) });
    if (!response.ok) {
      throw new Error((await this.parseErrorResponse(response)) || `HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  /** INSERT — create a new instance. */
  async insert(resourceType, object, options = {}) {
    const { namespace } = options;
    const url = `${this.baseUrl}/api/v1/resources/${resourceType}`;
    await this.ensureFreshToken();
    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(namespace),
      body: JSON.stringify(object),
    });
    if (!response.ok) {
      throw new Error((await this.parseErrorResponse(response)) || `HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  /** UPSERT — insert or replace by natural/id key. */
  async upsert(resourceType, object, options = {}) {
    const { namespace } = options;
    const url = `${this.baseUrl}/api/v1/resources/${resourceType}?upsert=true`;
    await this.ensureFreshToken();
    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(namespace),
      body: JSON.stringify(object),
    });
    if (!response.ok) {
      throw new Error((await this.parseErrorResponse(response)) || `HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  /** UPDATE — update an existing instance by id. */
  async update(resourceType, resourceId, object, options = {}) {
    const { namespace } = options;
    const url = `${this.baseUrl}/api/v1/resources/${resourceType}/${encodeURIComponent(resourceId)}`;
    await this.ensureFreshToken();
    const response = await fetch(url, {
      method: "PUT",
      headers: this.getHeaders(namespace),
      body: JSON.stringify(object),
    });
    if (!response.ok) {
      throw new Error((await this.parseErrorResponse(response)) || `HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  /** EXECUTE — call a procedure with named params. */
  async execute(procedureName, params = {}, options = {}) {
    const { namespace } = options;
    const url = `${this.baseUrl}/api/v1/resources/procedures/${procedureName}`;
    await this.ensureFreshToken();
    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(namespace),
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      throw new Error((await this.parseErrorResponse(response)) || `HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * EXECUTE, STREAMING — for procedures that stream their response
   * (e.g. LLM output). The body is a chunked JSON array of strings, not
   * SSE — this incrementally extracts complete string tokens as bytes
   * arrive and calls onChunk for each one.
   */
  async executeStreaming(procedureName, params = {}, onChunk, options = {}) {
    const { namespace, signal } = options;
    const url = `${this.baseUrl}/api/v1/resources/procedures/${procedureName}?stream=true&maxFlushInterval=50`;
    await this.ensureFreshToken();

    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(namespace),
      body: JSON.stringify(params),
      signal,
    });
    if (!response.ok) {
      throw new Error((await this.parseErrorResponse(response)) || `HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastProcessedIndex = 0;

    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          let searchStart = lastProcessedIndex;
          while (true) {
            const openQuote = buffer.indexOf('"', searchStart);
            if (openQuote === -1) break;

            let closeQuote = openQuote + 1;
            let foundClose = false;
            while (closeQuote < buffer.length) {
              if (buffer[closeQuote] === '"') {
                let backslashes = 0;
                while (buffer[closeQuote - 1 - backslashes] === "\\") backslashes++;
                if (backslashes % 2 === 0) {
                  foundClose = true;
                  break;
                }
              }
              closeQuote += buffer[closeQuote] === "\\" ? 2 : 1;
            }
            if (!foundClose) break;

            const jsonString = buffer.substring(openQuote, closeQuote + 1);
            try {
              const unescaped = JSON.parse(jsonString);
              if (onChunk && unescaped) onChunk(unescaped);
            } catch {
              // skip an unparsable fragment and continue
            }
            lastProcessedIndex = closeQuote + 1;
            searchStart = closeQuote + 1;
          }
        }
        if (done) break;
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      throw error;
    }
  }

  /** DELETE — remove an instance by id. */
  async delete(resourceType, resourceId, options = {}) {
    const { namespace } = options;
    const url = `${this.baseUrl}/api/v1/resources/${resourceType}/${encodeURIComponent(resourceId)}`;
    await this.ensureFreshToken();
    const response = await fetch(url, { method: "DELETE", headers: this.getHeaders(namespace) });
    if (!response.ok) {
      throw new Error((await this.parseErrorResponse(response)) || `HTTP ${response.status}: ${response.statusText}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}

const Vantiq = new VantiqAPI();
export default Vantiq;
