export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/status") {
      return handleStatus(env);
    }

    return handleSearch(url, env);
  },
};

async function handleStatus(env) {
  const { results } = await env.DB.prepare(
    "SELECT COUNT(*) as total, MAX(createdAtMillis) as newest, MIN(createdAtMillis) as oldest FROM notes"
  ).all();

  return new Response(JSON.stringify(results[0]), {
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function handleSearch(url, env) {
  const q = url.searchParams.get("q") || "";
  const classification = url.searchParams.get("classification");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const sourcesOnly = url.searchParams.get("sources") === "true";
  const mediaOnly = url.searchParams.get("media") === "true";
  const sortDir = url.searchParams.get("sort") === "asc" ? "ASC" : "DESC";

  let sql = "SELECT noteId, tweetId, createdAtMillis, classification, summary FROM notes WHERE 1=1";
  const params = [];

  const { clause, params: qParams } = buildKeywordClause(q);
  if (clause) {
    sql += ` AND ${clause}`;
    params.push(...qParams);
  }

  if (classification) { sql += " AND classification = ?"; params.push(classification); }
  if (from) { sql += " AND createdAtMillis >= ?"; params.push(Date.parse(from)); }
  if (to) { sql += " AND createdAtMillis <= ?"; params.push(Date.parse(to)); }
  if (sourcesOnly) { sql += " AND trustworthySources = 1"; }
  if (mediaOnly) { sql += " AND isMediaNote = 1"; }

  sql += ` ORDER BY createdAtMillis ${sortDir} LIMIT 50`;

  const { results } = await env.DB.prepare(sql).bind(...params).all();

  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// Baut aus "wort1 AND wort2 OR wort3" die SQL-Bedingung:
// (summary LIKE %wort1% AND summary LIKE %wort2%) OR (summary LIKE %wort3%)
function buildKeywordClause(q) {
  if (!q.trim()) return { clause: "", params: [] };

  const orGroups = q.split(/\s+OR\s+/i).map(g => g.trim()).filter(Boolean);
  const params = [];

  const orClauses = orGroups.map(group => {
    const andTerms = group.split(/\s+AND\s+/i).map(t => t.trim()).filter(Boolean);
    const andClauses = andTerms.map(term => {
      params.push(`%${term}%`);
      return "summary LIKE ?";
    });
    return `(${andClauses.join(" AND ")})`;
  });

  return { clause: `(${orClauses.join(" OR ")})`, params };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}