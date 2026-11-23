'use strict';
const { app } = require('@azure/functions');
const { handle } = require('../lib/handle');

function principalFrom(request) {
  // Set by Static Web Apps once sign-in is switched on. Absent while testing without Entra.
  const h = request.headers.get('x-ms-client-principal');
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, 'base64').toString('utf8')); } catch (e) { return null; }
}

app.http('submit', {
  methods: ['POST'],
  authLevel: 'anonymous',        // access is controlled by Static Web Apps routes (see staticwebapp.config.json)
  route: 'submit',
  handler: async (request, context) => {
    let payload;
    const text = await request.text();
    if (text.length > 400000) return { status: 413, jsonBody: { message: 'The submission is too large.' } };
    try { payload = JSON.parse(text); } catch (e) { return { status: 400, jsonBody: { message: 'Request body is not valid JSON.' } }; }
    const result = await handle(payload, process.env, fetch, principalFrom(request));
    if (result.detail) context.error('submit failed: ' + result.detail);   // detail stays in the logs, never sent to the browser
    return { status: result.status, jsonBody: result.body };
  }
});
