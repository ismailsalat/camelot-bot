// A control is successful only after the worker acknowledges its completion.
export class WorkerCommands {
  constructor(send, timeout = 90000) { this.send = send; this.timeout = timeout; this.sequence = 0; this.pending = new Map(); }
  request(job) {
    const requestId = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Streaming change timed out. Press Stop, then Play.')); }, this.timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({...job, requestId}); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  accept(event) {
    if (event.event !== 'ack') return false;
    const pending = this.pending.get(event.requestId);
    if (!pending) return true;
    clearTimeout(pending.timer); this.pending.delete(event.requestId);
    if (event.ok) pending.resolve(event);
    else pending.reject(new Error(event.message || 'Streaming change failed. Try Play again.'));
    return true;
  }
  close() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Streaming account disconnected.')); }
    this.pending.clear();
  }
}
