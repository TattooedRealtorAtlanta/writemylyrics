/**
 * Read raw request body as a Buffer.
 * Needed for Stripe webhook signature verification.
 */
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse request body as JSON.
 */
async function getJsonBody(req) {
  const raw = await getRawBody(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

module.exports = { getRawBody, getJsonBody };
