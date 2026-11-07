/** Close the duplicate seeded request (0da8fe94…) using the product's own action, not a DELETE. */
const BASE = 'http://127.0.0.1:3010';
const EMAIL = 'owner@fictional.tickmark.invalid';
const PASSWORD = process.argv[2];
const DUPLICATE = '0da8fe94-d980-41aa-883a-fd5ebe92d31b';

let cookie = '';
async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
    redirect: 'manual',
  });
  const set = response.headers.getSetCookie();
  if (set.length) cookie = set.map((v) => v.split(';')[0]).join('; ');
  return response;
}
const post = (path, fields) => request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
});

console.log('signin:', (await post('/signin', { email: EMAIL, password: PASSWORD })).status);
const closed = await post(`/requests/${DUPLICATE}/close`, {});
console.log('close duplicate:', closed.status, closed.headers.get('location'));
const board = await (await request('/requests')).text();
const openCount = /(\d+)\s*\n?\s*waiting on clients/i.exec(board)?.[1];
console.log('board shows waiting-on-clients:', openCount);
