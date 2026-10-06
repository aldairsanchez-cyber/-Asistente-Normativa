const chunks = require('../data/reglamento.json');
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const STOP = new Set('de la el los las un una y o en para por con que es son del al se a'.split(' '));

function search(query, k = 6) {
  const words = norm(query).split(/\W+/).filter(w => w.length > 2 && !STOP.has(w));
  return chunks.map(c => { const t = norm(c.t); return { c, s: words.reduce((n, w) => n + (t.split(w).length - 1), 0) }; })
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map(x => x.c);
}

const SYSTEM = `Eres un asistente de consulta de normativa para estudiantes y profesionales de arquitectura.
Responde SOLO con base en los FRAGMENTOS del reglamento que se te entregan. No inventes valores.
Indica siempre el documento y la página (y el artículo si aparece en el fragmento).
Si el dato no está en los fragmentos, responde: "No encontré este dato en el reglamento cargado".
Si falta información (tipo de edificio, uso, área), pregúntala antes de responder.
Formato: Respuesta: [valor o conclusión] / Fuente: [artículo, página] / Condiciones: [a qué aplica].
Cierra con: "Confirma este dato en el texto oficial antes de usarlo". Responde en español.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  try {
    const msgs = (req.body.messages || []).slice(-6);
    const last = msgs[msgs.length - 1];
    if (!last) return res.status(400).json({ error: 'Falta la pregunta' });
    const ctx = search(msgs.filter(m => m.role === 'user').map(m => m.text).join(' '));
    const frag = ctx.length ? ctx.map(c => `[${c.d || "Documento"}, página ${c.p}]\n${c.t}`).join('\n---\n') : '(sin fragmentos relevantes)';
    const contents = msgs.map((m, i) => ({ role: m.role, parts: [{ text: i === msgs.length - 1 ? `FRAGMENTOS DEL REGLAMENTO:\n${frag}\n\nPREGUNTA: ${m.text}` : m.text }] }));
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents })
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: r.status === 429 ? 'Límite gratuito alcanzado. Espera un minuto e intenta de nuevo.' : (j.error?.message || 'Error del modelo') });
    res.json({ answer: j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || 'Sin respuesta.' });
  } catch (e) { res.status(500).json({ error: 'Error del servidor: ' + e.message }); }
};
