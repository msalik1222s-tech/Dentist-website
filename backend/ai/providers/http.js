// Shared HTTP helper for the REST-based provider adapters.
//
// Lives in its own module rather than in the registry so adapters don't have
// to require the registry that loads them.

const errors = require("../errors");

// A fetch with a hard deadline: one slow vendor must not hold a serverless
// invocation open until the platform kills it mid-request.
async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    throw errors.PROVIDER_FAILED(err.name === "AbortError" ? "timed out" : err.message);
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text();
  if (!response.ok) {
    // Truncated: vendor error bodies can be long and echo the request back.
    throw errors.PROVIDER_FAILED(`HTTP ${response.status} ${body.slice(0, 300)}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw errors.PROVIDER_FAILED("response was not valid JSON");
  }
}

module.exports = { fetchJson };
