const chunks = require('../data/reglamento.json');
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const STOP = new Set('de la el los las un una y o en para por con que es son del al se a'.split(' '));

function search(query, k = 8) {
  const words = norm(query).split(/\W+/).filter(w => w.length > 2 && !STOP.has(w)).map(w => w.length > 5 ? w.slice(0, 5) : w);
  return chunks.map(c => { const t = norm(c.t); return { c, s: words.reduce((n, w) => n + (t.split(w).length - 1), 0) }; })
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map(x => x.c);
}

const SYSTEM = `Eres un asistente de consulta de normativa para estudiantes y profesionales de arquitectura.
Responde SOLO con base en los FRAGMENTOS del reglamento que se te entregan. No inventes valores.
Indica siempre el documento y la página (y el artículo si aparece en el fragmento).
Si el dato no está en los fragmentos, responde: "No encontré este dato en el reglamento cargado".
Si falta información (tipo de edificio, uso, área), pregúntala antes de responder.
Formato: Respuesta: [valor o conclusión] / Fuente: [artículo, página] / Condiciones: [a qué aplica].
Cierra con: "Confirma este dato en el texto oficial antes de usarlo". Responde en español.
Estilo: escribe en texto plano. NO uses LaTeX ni signos de dólar; escribe las fórmulas en una sola línea (ejemplo: pendiente (%) = altura / longitud x 100).
Usa **negrita** solo para las etiquetas (Respuesta, Fuente, Condiciones) y guiones simples para listas. No uses tablas ni encabezados con #.
Sé breve: máximo 8 líneas, salvo que la persona pida más detalle.`;


// Deja el historial en el formato que pide Claude: empieza con user y alterna roles
function limpiar(msgs) {
  const out = [];
  for (const m of msgs) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (!out.length && role !== 'user') continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + m.text;
    else out.push({ role, content: m.text });
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  try {
    const raw = (req.body.messages || []).slice(-6);
    const msgs = limpiar(raw);
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user') return res.status(400).json({ error: 'Falta la pregunta' });
    const ctx = search(raw.filter(m => m.role === 'user').map(m => m.text).join(' '));
    const frag = ctx.length ? ctx.map(c => `[${c.d || 'Documento'}, página ${c.p}]\n${c.t}`).join('\n---\n') : '(sin fragmentos relevantes)';
    last.content = `FRAGMENTOS DEL REGLAMENTO:\n${frag}\n\nPREGUNTA: ${last.content}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, system: SYSTEM, messages: msgs })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const msg = r.status === 401 ? 'La clave de API no es válida.' : r.status === 429 ? 'Demasiadas consultas seguidas. Espera unos segundos.' : (j.error?.message || 'Error del modelo');
      return res.status(r.status).json({ error: msg });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body) {            // la respuesta llega por partes y se reenvía en vivo
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith('data:')) continue;
        try { const e = JSON.parse(l.slice(5)); if (e.type === 'content_block_delta' && e.delta && e.delta.text) res.write(e.delta.text); } catch (x) {}
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'Error del servidor: ' + e.message }); else res.end();
  }
};
