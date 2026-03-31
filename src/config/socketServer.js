import { Server } from 'socket.io';

/** @type {import('socket.io').Server | null} */
let io = null;

/**
 * Initializes the Socket.io server attached to the given HTTP server.
 * Clients join course-scoped rooms to receive targeted events.
 * @param {import('http').Server} httpServer
 * @returns {import('socket.io').Server}
 */
export function initSocketServer(httpServer) {
    io = new Server(httpServer, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
        },
        path: '/socket.io',
        transports: ['websocket', 'polling'],
    });

    io.on('connection', (socket) => {
        // Client joins a course room to receive subject events for that course
        socket.on('join:course', (courseId) => {
            if (courseId) socket.join(`course:${courseId}`);
        });

        socket.on('leave:course', (courseId) => {
            if (courseId) socket.leave(`course:${courseId}`);
        });

        // Client joins a per-user room to receive personal notifications in real-time
        socket.on('join:user', (userId) => {
            if (userId) socket.join(`user:${userId}`);
        });

        socket.on('leave:user', (userId) => {
            if (userId) socket.leave(`user:${userId}`);
        });

        // Client joins a per-user chat room to receive real-time chat messages
        socket.on('join:chat', ({ userId, origin }) => {
            if (userId && origin) socket.join(`chat:${userId}:${origin}`);
        });

        socket.on('leave:chat', ({ userId, origin }) => {
            if (userId && origin) socket.leave(`chat:${userId}:${origin}`);
        });
    });

    return io;
}

/**
 * Returns the initialized Socket.io server, or null if not yet initialized.
 * @returns {import('socket.io').Server | null}
 */
export function getIO() {
    return io;
}