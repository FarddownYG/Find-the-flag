/// <reference lib="webworker" />
import { createWorkerHandler, type WorkerRequest } from './worker-handler';

const handle = createWorkerHandler((res) => self.postMessage(res));
self.onmessage = (ev: MessageEvent<WorkerRequest>) => void handle(ev.data);
