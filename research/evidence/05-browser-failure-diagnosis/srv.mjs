import https from 'node:https'; import http from 'node:http'; import fs from 'node:fs';
const opts = { key: fs.readFileSync('key.pem'), cert: fs.readFileSync('cert.pem') };
const log = [];
function handler(req, res) {
  log.push(`${new Date().toISOString()} ${req.method} ${req.url} origin=${req.headers.origin||'-'} ct=${req.headers['content-type']||'-'} acrm=${req.headers['access-control-request-method']||'-'} acrh=${req.headers['access-control-request-headers']||'-'}`);
  fs.writeFileSync('srv.log', log.join('\n')+'\n');
  // Deliberately NO CORS headers: exactly like the incident's dev server.
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({files:[{contentType:'application/fhir+json',embedded:'eyJhbGciOiJkaXIifQ..'}]}));
}
https.createServer(opts, handler).listen(5173, '127.0.0.1', ()=>console.log('https 5173'));
http.createServer(handler).listen(5174, '127.0.0.1', ()=>console.log('http 5174'));
