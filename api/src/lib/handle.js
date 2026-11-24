'use strict';
// Core logic for /api/submit. No Azure dependencies, so it can be tested on its own.
const map = require('./fieldmap.json');

const STAGE = 'Application Submitted';
const REC_TYPE_DEV_NAME = 'University_Consultancy';
const MAX_ROWS = 50;

let tokenCache = null;   // { token, instanceUrl, expires }
let rtCache = null;      // { id, key }

function todayLondon() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); }

function fail(status, message, detail) { return { status, body: { message }, detail }; }

// ---------- validation (the server never trusts the browser) ----------
function validate(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['Request body is not valid.'];
  const c = payload.consultancy;
  if (!c || typeof c !== 'object') return ['Missing consultancy details.'];

  // only known fields, correct types
  for (const [k, v] of Object.entries(c)) {
    const def = map.main[k];
    if (!def) { errors.push('Unknown field: ' + k); continue; }
    if (def.kind === 'yn') { if (typeof v !== 'boolean') errors.push(k + ' must be true/false'); }
    else if (def.kind === 'num') { if (typeof v !== 'number' || !isFinite(v)) errors.push(k + ' must be a number'); }
    else if (typeof v !== 'string') errors.push(k + ' must be text');
    else {
      const max = map.len[k];
      if (max && v.length > max) errors.push(k + ' is too long');
      if (map.pick[k] && k !== 'Consultancy_Impact_Area_GC__c' && !map.pick[k].includes(v)) errors.push(k + ' has an unrecognised value');
      if (k === 'Consultancy_Impact_Area_GC__c' && !v.split(';').every(x => map.pick[k].includes(x))) errors.push(k + ' has an unrecognised value');
      if (def.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(k + ' must be a date');
      if (k === 'Client_Contact_Phone_GC__c' && v) { const d = v.replace(/\D/g, '').length; if (!/^[0-9+()\-\s]{1,20}$/.test(v) || d < 7 || d > 15) errors.push('Contact telephone number is not valid.'); }
    }
  }
  if (errors.length) return errors;

  // eligibility gate
  const primary = c.Primary_Purpose_Consultancy_GC__c;
  if (c.Meets_Consultancy_Definition_GC__c !== 'Yes') errors.push('The project does not meet the definition of consultancy.');
  if (c.Eligible_By_Employment_Status_GC__c !== 'Yes') errors.push('The consultant is not eligible by employment status.');
  if (c.Line_Manager_Approval_GC__c !== 'Yes') errors.push('Line manager approval is required.');
  if (c.Over_50_Days_12_Months_GC__c === 'Yes' && primary !== 'Yes') errors.push('More than 50 days in 12 months is not permitted.');

  // mandatory fields
  const surplusOff = primary === 'Yes';
  for (const [api, def] of Object.entries(map.main)) {
    let need = def.req === 'Y';
    if (api === 'Conflict_Of_Interest_Explanation_GC__c') need = c.Potential_Conflict_Of_Interest_GC__c === true;
    if (api === 'Personal_Payment_Pct_GC__c' || api === 'Personal_Payments_Over_25k_GC__c') need = !surplusOff;
    if (need && (c[api] === undefined || c[api] === '')) errors.push('Missing: ' + (def.form || api));
  }
  if (c.Project_Start_Date_GC__c && c.Project_End_Date_GC__c && c.Project_End_Date_GC__c < c.Project_Start_Date_GC__c) errors.push('The completion date cannot be before the start date.');
  if (c.Project_Start_Date_GC__c && c.Project_Start_Date_GC__c < todayLondon()) errors.push('The start date cannot be in the past.');
  if (c.Policy_Read_GC__c !== true) errors.push('You must read the University Global Consultancy Policy before submitting.');
  if (typeof c.Academic_Days_GC__c === 'number' && c.Academic_Days_GC__c <= 0) errors.push('Academic days must be above zero.');
  if (typeof c.Personal_Payment_Pct_GC__c === 'number' && (c.Personal_Payment_Pct_GC__c < 0 || c.Personal_Payment_Pct_GC__c > 50)) errors.push('Personal payment percentage must be 0 to 50.');

  // child rows: optional lists, but any row present must be complete
  for (const [key, def] of Object.entries(map.rows)) {
    const list = payload[key] === undefined ? [] : payload[key];
    if (!Array.isArray(list)) { errors.push(key + ' must be a list'); continue; }
    if (list.length > MAX_ROWS) errors.push(key + ' has too many rows');
    list.forEach((r, i) => {
      if (!r || typeof r !== 'object') { errors.push(def.label + ' ' + (i + 1) + ' is not valid'); return; }
      for (const [k, v] of Object.entries(r)) {
        if (k === 'PG_Student_HWU_GC__c') continue;      // derived below
        const fd = def.fields[k];
        if (!fd) { errors.push('Unknown field in ' + def.label + ': ' + k); continue; }
        if (fd.kind === 'num') { if (typeof v !== 'number' || !isFinite(v) || v < 0) errors.push(def.label + ' ' + (i + 1) + ': ' + k + ' must be a positive number'); }
        else if (typeof v !== 'string') errors.push(def.label + ' ' + (i + 1) + ': ' + k + ' must be text');
        else {
          if (fd.max && v.length > fd.max) errors.push(def.label + ' ' + (i + 1) + ': ' + k + ' is too long');
          if (map.pick[k] && !map.pick[k].includes(v)) errors.push(def.label + ' ' + (i + 1) + ': ' + k + ' has an unrecognised value');
        }
      }
      for (const k of Object.keys(def.fields)) {
        if (r[k] === undefined || r[k] === '') errors.push(def.label + ' ' + (i + 1) + ' is incomplete');
      }
    });
  }
  return [...new Set(errors)];
}

// ---------- Salesforce ----------
async function getToken(env, fetchFn) {
  const now = Date.now();
  if (tokenCache && tokenCache.expires > now) return tokenCache;
  const res = await fetchFn(env.SF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SF_CLIENT_ID, client_secret: env.SF_CLIENT_SECRET }).toString()
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error('Salesforce token request failed: HTTP ' + res.status + ' ' + (j.error || ''));
  tokenCache = { token: j.access_token, instanceUrl: j.instance_url, expires: now + 25 * 60 * 1000 };
  return tokenCache;
}

async function sf(env, fetchFn, method, path, body) {
  let t = await getToken(env, fetchFn);
  const call = () => fetchFn(t.instanceUrl + path, { method, headers: { Authorization: 'Bearer ' + t.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let res = await call();
  if (res.status === 401) { tokenCache = null; t = await getToken(env, fetchFn); res = await call(); }
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json: j };
}

async function recordTypeId(env, fetchFn, ver) {
  if (rtCache && rtCache.key === env.SF_TOKEN_URL) return rtCache.id;
  const q = "SELECT Id FROM RecordType WHERE SobjectType='Consultancy__c' AND DeveloperName='" + REC_TYPE_DEV_NAME + "' LIMIT 1";
  const r = await sf(env, fetchFn, 'GET', '/services/data/' + ver + '/query?q=' + encodeURIComponent(q));
  if (!r.ok || !r.json.records || !r.json.records.length) throw new Error('Record type lookup failed: HTTP ' + r.status);
  rtCache = { id: r.json.records[0].Id, key: env.SF_TOKEN_URL };
  return rtCache.id;
}

function buildTree(payload, rtId) {
  const c = Object.assign({}, payload.consultancy);
  const root = Object.assign({ attributes: { type: 'Consultancy__c', referenceId: 'c1' } }, c, { RecordTypeId: rtId, Stage_GC__c: STAGE,
    // submitting the form is the consultant's declaration (set here, never taken from the browser)
    Consultant_Declaration_Confirmed_GC__c: true, Consultant_Declaration_Date_GC__c: new Date().toISOString() });
  for (const [key, def] of Object.entries(map.rows)) {
    const list = Array.isArray(payload[key]) ? payload[key] : [];
    if (!list.length) continue;
    root[def.rel] = { records: list.map((r, i) => {
      const rec = Object.assign({ attributes: { type: def.type, referenceId: key.slice(0, 3) + (i + 1) } }, r);
      if (key === 'subcontractors') rec.PG_Student_HWU_GC__c = /^\s*post graduate student hwu\s*$/i.test(r.External_Organisation_GC__c || '');
      else delete rec.PG_Student_HWU_GC__c;
      return rec;
    }) };
  }
  return { records: [root] };
}

async function handle(payload, env, fetchFn, principal) {
  for (const k of ['SF_TOKEN_URL', 'SF_CLIENT_ID', 'SF_CLIENT_SECRET']) if (!env[k]) return fail(500, 'The service is not configured.', 'Missing setting ' + k);
  const errors = validate(payload);
  if (errors.length) return { status: 400, body: { message: 'Some answers need attention: ' + errors.slice(0, 6).join(' ') } };
  const ver = env.SF_API_VERSION || 'v68.0';
  try {
    const rt = await recordTypeId(env, fetchFn, ver);
    const tree = buildTree(payload, rt);
    const r = await sf(env, fetchFn, 'POST', '/services/data/' + ver + '/composite/tree/Consultancy__c', tree);
    if (!r.ok || r.json.hasErrors) return fail(502, 'We could not save your request. Please try again, or email consultancy@hw.ac.uk.', 'Salesforce rejected the request: ' + JSON.stringify(r.json).slice(0, 1500));
    const id = r.json.results[0].id;
    let rec = await sf(env, fetchFn, 'GET', '/services/data/' + ver + '/sobjects/Consultancy__c/' + id + '?fields=Name,Project_Title_GC__c');
    if (!rec.ok) rec = await sf(env, fetchFn, 'GET', '/services/data/' + ver + '/sobjects/Consultancy__c/' + id + '?fields=Name');
    // reference shown to the consultant: the Project Title formula (Project ID - last name - client), falling back to the Project ID
    const ref = rec.ok ? (rec.json.Project_Title_GC__c || rec.json.Name) : id;
    return { status: 200, body: { projectId: ref }, submitter: principal && principal.userDetails };
  } catch (e) {
    return fail(502, 'We could not save your request. Please try again, or email consultancy@hw.ac.uk.', String(e && e.message || e));
  }
}

function reset() { tokenCache = null; rtCache = null; }
module.exports = { handle, validate, buildTree, reset };
