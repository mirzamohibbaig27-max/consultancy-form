'use strict';
const assert = require('assert');
const { handle, validate, buildTree, reset } = require('../src/lib/handle');
const map = require('../src/lib/fieldmap.json');

function good() {
  const c = {};
  for (const [api, d] of Object.entries(map.main)) {
    if (d.req === 'N') continue;
    if (api === 'Conflict_Of_Interest_Explanation_GC__c') continue;
    if (d.kind === 'yn') c[api] = false;
    else if (d.kind === 'num') c[api] = 3;
    else if (d.kind === 'date') c[api] = '2027-02-01';
    else if (map.pick[api]) c[api] = api === 'Consultancy_Impact_Area_GC__c' ? map.pick[api][0] : map.pick[api][0];
    else c[api] = 'x'.repeat(Math.min(5, map.len[api] || 5));
  }
  Object.assign(c, { Meets_Consultancy_Definition_GC__c: 'Yes', Eligible_By_Employment_Status_GC__c: 'Yes', Line_Manager_Approval_GC__c: 'Yes', Over_50_Days_12_Months_GC__c: 'No', Primary_Purpose_Consultancy_GC__c: 'No', Project_End_Date_GC__c: '2027-03-01', Personal_Payment_Pct_GC__c: 10, Consultant_Email_GC__c: 'a@hw.ac.uk', Client_Email_GC__c: 'c@x.com' });
  return { formVersion: 'V11', consultancy: c, unmapped: { clientaddress: '1 High St' }, supportingStaff: [], nonStaffCosts: [], subcontractors: [] };
}
function mockFetch(log, opts = {}) {
  return async (url, o = {}) => {
    log.push({ url, method: o.method, body: o.body });
    const j = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url.includes('/oauth2/token')) return j(200, { access_token: 'tok', instance_url: 'https://sf.test' });
    if (url.includes('/query?')) return j(200, { records: [{ Id: '012RT' }] });
    if (url.includes('/composite/tree/')) return opts.sfError ? j(400, { hasErrors: true, results: [{ errors: [{ message: 'boom' }] }] }) : j(201, { hasErrors: false, results: [{ referenceId: 'c1', id: 'a2hX' }] });
    if (url.includes('/sobjects/Consultancy__c/')) return j(200, { Name: 'CP202627_0042' });
    return j(404, {});
  };
}
const env = { SF_TOKEN_URL: 'https://sf.test/services/oauth2/token', SF_CLIENT_ID: 'id', SF_CLIENT_SECRET: 'secret' };

(async () => {
  assert.deepStrictEqual(validate(good()), [], 'good payload validates');
  let p = good(); p.consultancy.Line_Manager_Approval_GC__c = 'No'; assert(validate(p).some(e => /manager/i.test(e)), 'manager approval blocks');
  p = good(); p.consultancy.Meets_Consultancy_Definition_GC__c = 'No'; assert(validate(p).length, 'definition blocks');
  p = good(); p.consultancy.Over_50_Days_12_Months_GC__c = 'Yes'; assert(validate(p).some(e => /50 days/.test(e)), '50 days blocks');
  p.consultancy.Primary_Purpose_Consultancy_GC__c = 'Yes'; assert(!validate(p).some(e => /50 days/.test(e)), '50 days ok for primary-purpose staff');
  p = good(); delete p.consultancy.Project_name_GC__c; assert(validate(p).some(e => /ptitle/.test(e)), 'missing required');
  p = good(); p.consultancy.Potential_Conflict_Of_Interest_GC__c = true; assert(validate(p).some(e => /coi_explain/.test(e)), 'coi explanation needed');
  p = good(); p.consultancy.Evil__c = 'x'; assert(validate(p).some(e => /Unknown field/.test(e)), 'unknown field rejected');
  p = good(); p.consultancy.OwnerId = '005'; assert(validate(p).some(e => /Unknown field/.test(e)), 'cannot set owner from browser');
  p = good(); p.consultancy.Stage_GC__c = 'Approved'; assert(validate(p).some(e => /Unknown field/.test(e)), 'cannot set stage from browser');
  p = good(); p.consultancy.Campus_GC__c = 'Narnia'; assert(validate(p).some(e => /unrecognised/.test(e)), 'bad picklist');
  p = good(); p.supportingStaff = [{ Staff_Name_GC__c: 'A' }]; assert(validate(p).some(e => /incomplete/.test(e)), 'half row rejected');
  p = good(); p.supportingStaff = [{ Staff_Name_GC__c: 'A', Staff_Category_GC__c: 'Academic', Days_on_Project_GC__c: 2 }]; assert.deepStrictEqual(validate(p), [], 'full row ok');
  p = good(); p.unmapped = {}; assert(validate(p).some(e => /clientaddress/.test(e)), 'address needed');

  // happy path
  reset(); let log = []; p = good();
  p.subcontractors = [{ Contractor_Name_GC__c: 'N', External_Organisation_GC__c: 'Post Graduate Student HWU', Days_on_Project_GC__c: 1, Work_Description_GC__c: 'w', Cost_GC__c: 5 }];
  p.nonStaffCosts = [{ Cost_Item_GC__c: 'Equipment', Description_GC__c: 'd', Cost_GC__c: 1 }];
  let r = await handle(p, env, mockFetch(log), null);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.projectId, 'CP202627_0042');
  const tree = JSON.parse(log.find(l => l.url.includes('/composite/tree/')).body).records[0];
  assert.strictEqual(tree.RecordTypeId, '012RT'); assert.strictEqual(tree.Stage_GC__c, 'Application Submitted');
  assert.strictEqual(tree.attributes.type, 'Consultancy__c');
  assert.strictEqual(tree.Sub_Contractors_PG_Students__r.records[0].PG_Student_HWU_GC__c, true);
  assert.strictEqual(tree.Non_Staff_Costs__r.records[0].attributes.type, 'Non_Staff_Cost__c');
  assert(!('Supporting_Staff__r' in tree), 'no empty child lists');
  assert(/Client address \(from form\): 1 High St/.test(tree.Additional_Comments_GC__c));
  // token reused
  await handle(good(), env, mockFetch(log), null);
  assert.strictEqual(log.filter(l => l.url.includes('/oauth2/token')).length, 1, 'token cached');
  // Salesforce error is hidden from the browser
  reset(); r = await handle(good(), env, mockFetch([], { sfError: true }), null);
  assert.strictEqual(r.status, 502); assert(!/boom/.test(JSON.stringify(r.body)), 'no internal detail leaks'); assert(/boom/.test(r.detail), 'detail kept for logs');
  // missing settings
  r = await handle(good(), {}, mockFetch([]), null); assert.strictEqual(r.status, 500);
  console.log('all tests passed');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
