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

  // Forward other requests to the main app if it's ready?
  // No, this is just a placeholder. The main app will take over the port eventually
  // or this process will be killed once the main app starts?
  // Actually, both cannot bind to the same port.
  // STRATEGY: This script should run on a DIFFERENT port, or handle traffic until main app is ready.
  // But standard practice: main app binds PORT. 
  
  // If we want this to be a "bootstrap" server, it must bind PORT first.
  // Then when main app is ready, this must stop? 
  // Or we use a proxy?
  
  // Railway expects PORT to answer.
  
  res.writeHead(503, { 'Content-Type': 'text/plain' });
  res.end('Service Starting...');
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.log('⚠️ Port in use, assuming main app is taking over...');
        process.exit(0);
    }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔎 Bootstrap health server listening on http://0.0.0.0:${PORT}/health`);
});

// Keep process alive until explicitly killed
process.on('SIGTERM', () => {
  console.log('🔔 Bootstrap health server shutting down');
  server.close(() => process.exit(0));
});
