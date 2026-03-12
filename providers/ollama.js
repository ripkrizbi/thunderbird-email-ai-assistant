import { buildPrompt } from '../core/analysis.js';
import {extractJson} from "./utils";
import { log, error } from '../core/debug.js';

export async function analyzeWithOllama(settings, structuredData, customTags) {
  const prompt = buildPrompt(structuredData, customTags);
  const { ollamaApiUrl, ollamaModel, ollamaApiTimeout } = settings;
  const timeoutMs = (ollamaApiTimeout || 120) * 1000; // Convert seconds to milliseconds
  
  log("Spam-Filter Extension: Ollama Analysis Starting");
  log("Ollama URL:", ollamaApiUrl);
  log("Ollama Model:", ollamaModel);
  log("Ollama Timeout:", ollamaApiTimeout, "seconds");
  log("Prompt length:", prompt.length);

  try {
    // --- Health check: GET /api/tags (fast, confirms server is up and model exists) ---
    const baseUrl = ollamaApiUrl.substring(0, ollamaApiUrl.indexOf('/api/')) || ollamaApiUrl;
    log("Health-checking Ollama at", baseUrl + '/api/tags');
    try {
      const healthController = new AbortController();
      const healthTimeout = setTimeout(() => healthController.abort(), 10000); // 10s max
      const tagsResponse = await fetch(baseUrl + '/api/tags', { method: 'GET', signal: healthController.signal });
      clearTimeout(healthTimeout);
      if (tagsResponse.ok) {
        const tagsData = await tagsResponse.json();
        const models = (tagsData.models || []).map(m => m.name);
        log("Available Ollama models:", models.join(', ') || '(none)');
        const modelFound = models.some(m => m === ollamaModel || m.startsWith(ollamaModel + ':') || ollamaModel.startsWith(m.split(':')[0]));
        if (!modelFound) {
          error(`Model "${ollamaModel}" not found on Ollama instance. Available: ${models.join(', ')}`);
          throw new Error(`Model "${ollamaModel}" is not installed on the Ollama server at ${baseUrl}. Available models: ${models.join(', ') || '(none)'}`);
        }
        log(`Model "${ollamaModel}" confirmed available.`);
      } else {
        log("Health check returned non-OK status, proceeding anyway:", tagsResponse.status);
      }
    } catch (healthErr) {
      if (healthErr.message.includes('not installed') || healthErr.message.includes('not found')) throw healthErr;
      log("Health check failed (non-fatal, will still attempt generate):", healthErr.message);
    }
    // --- End health check ---

    log("Sending request to Ollama API...");
    
    // Create an abort controller with configurable timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(ollamaApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          prompt: prompt,
          format: "json",
          stream: false
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      log("Ollama API Response Status:", response.status, response.statusText);
      
      if (!response.ok) {
        const errorText = await response.text();
        error(`Ollama API Error ${response.status} from ${ollamaApiUrl} – ${response.statusText}:`, errorText);
        if (response.status === 405) {
          throw new Error(`405 Method Not Allowed from ${ollamaApiUrl}. Check that the URL ends with /api/generate (POST endpoint). The Ollama root URL and /api/tags do NOT accept POST requests.`);
        }
        throw new Error(`API request failed: ${response.status} ${response.statusText} – ${errorText.substring(0, 200)}`);
      }

      const result = await response.json();
      log("Ollama Response received, response length:", result.response.length);
      log("Ollama raw response:", result.response.substring(0, 200) + "...");

      const rawText = result.response;
      const jsonText = extractJson(rawText);
      log("Extracted JSON:", jsonText.substring(0, 200) + "...");
      
      const parsed = JSON.parse(jsonText);
      log("Parsed analysis result:", parsed);
      return parsed;
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        error(`Ollama API timeout (${ollamaApiTimeout}s) - Connection unavailable or too slow at ${ollamaApiUrl}`);
      } else {
        error(`Ollama API Error (URL: ${ollamaApiUrl}, model: ${ollamaModel}):`, fetchErr);
      }
      throw fetchErr;
    }
  } catch (err) {
    error(`Ollama Error (URL: ${ollamaApiUrl}, model: ${ollamaModel}):`, err);
    throw err; // re-throw so analyzeEmail / processMessage can react correctly
  }
}
