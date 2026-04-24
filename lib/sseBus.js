import { EventEmitter } from 'node:events'
export const sseBus = new EventEmitter()
sseBus.setMaxListeners(0)
