import { createServer } from 'http';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

const server = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/_health' || req.url === '/health/live') {
    const payload = {
      status: 'ok',
      server: 'bootstrap-health-server',
      timestamp: new Date().toISOString(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  // Provide a tiny default response for other paths
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔎 Bootstrap health server listening on http://0.0.0.0:${PORT}/health`);
});

// Keep process alive until explicitly killed
process.on('SIGTERM', () => {
  console.log('🔔 Bootstrap health server shutting down');
  server.close(() => process.exit(0));
});
