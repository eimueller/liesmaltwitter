const FREE_DAILY_READ_LIMIT = 5000000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/status") {
      return handleStatus(env);
    }

    return handleSearch(url, env, ctx);
  },
};

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function trackReads(env, rowsRead, ctx) {
  const task = (async () => {
    try {
      const rows = await env.DB.prepare(
        "SELECT key, value FROM meta WHERE key IN ('reads_today', 'reads_date')"
      ).all();
      const meta = {};
      for (const row of rows.results) meta[row.key] = row.value;

      const today = todayUTC();
      let count = parseInt(meta.reads_today || "0", 10);
      if (meta.reads_date !== today) {
        count = 0;
      }
      count += rowsRead;

      await env.DB.batch([
        env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('reads_today', ?)").bind(String(count)),
        env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('reads_date', ?)").bind(today),
      ]);
    } catch (e) {}
  })();
  ctx.waitUntil(task);
}

async function handleStatus(env) {
  try {
    const metaResult = await env.DB.prepare("SELECT key, value FROM meta").all();
    const meta = {};
    for (const row of metaResult.results) meta[row.key] = row.value;

    const today = todayUTC();
    const readsToday = meta.reads_date === today ? parseInt(meta.reads_today || "0", 10) : 0;
    const percentUsed = Math.min(100, (readsToday / FREE_DAILY_READ_LIMIT) * 100);
    const total = meta.total ? Number(meta.total) : null;
    const remainingReads = Math.max(0, FREE_DAILY_READ_LIMIT - readsToday);
    const estSearchesLeft = total ? Math.floor(remainingReads / total) : null;

    return new Response(JSON.stringify({
      total,
      newest: meta.newest || null,
      oldest: meta.oldest || null,
      last_attempt: meta.last_attempt || null,
      last_status: meta.last_status || null,
      reads_today: readsToday,
      reads_percent: Math.round(percentUsed * 10) / 10,
      est_searches_left: estSearchesLeft,
    }), {
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
}

async function handleSearch(url, env, ctx) {
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

  const { results, meta } = await env.DB.prepare(sql).bind(...params).all();

  if (meta && typeof meta.rows_read === "number") {
    await trackReads(env, meta.rows_read, ctx);
  }

  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

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
    "Access-Control-Allow-Origin": "https://eimueller.github.io",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}