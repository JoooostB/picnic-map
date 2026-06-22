import { EventEmitter } from 'events';

// In-process pub/sub between the prober and any open SSE connections.
export const bus = new EventEmitter();
bus.setMaxListeners(100); // plenty for a handful of browser tabs
