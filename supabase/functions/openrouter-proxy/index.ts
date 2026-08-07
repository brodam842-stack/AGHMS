import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * OpenRouter Proxy — Supabase Edge Function
 *
 * Browser → this Edge Function → OpenRouter API
 *
 * Keeps the OpenRouter API key server-side (never shipped to the browser) and
 * side-steps CORS. The key is read from the `OPENROUTER_API_KEY` Edge Function
 * secret (set it in the Supabase dashboard → Edge Functions → Secrets, or via
 * `supabase secrets set OPENROUTER_API_KEY=sk-or-...`).
 *
 * The client sends: { endpoint?: '/chat/completions', payload: {...} }
 * and this function forwards `payload` to `https://openrouter.ai/api/v1<endpoint>`.
 */

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? '';

// Optional attribution headers recommended by OpenRouter (used for ranking).
// NOTE: HTTP header values must be ByteString (Latin-1) — keep this ASCII-only
// (no em-dashes/smart punctuation) or fetch() throws an invalid-ByteString error.
const APP_URL = Deno.env.get('APP_URL') ?? 'https://aghms.rngpitai.com';
const APP_TITLE = 'AGHMS - RNGPIT Academic Governance';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { endpoint = '/chat/completions', payload } = body;

    if (!OPENROUTER_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'OPENROUTER_API_KEY secret not configured in Supabase Edge Function secrets.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const orResponse = await fetch(`${OPENROUTER_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'HTTP-Referer': APP_URL,
        'X-Title': APP_TITLE,
      },
      body: JSON.stringify(payload),
    });

    const data = await orResponse.json();

    return new Response(JSON.stringify(data), {
      status: orResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('OpenRouter Proxy error:', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown proxy error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
