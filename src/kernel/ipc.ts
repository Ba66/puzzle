import type { DmesgEntry, DmesgLevel, IpcHandler, IpcMessage, PID } from './types.ts';

const DMESG_LIMIT = 200;

interface Subscription {
  readonly ownerId: string;
  readonly ownerPid: PID | null;
  readonly handler: IpcHandler;
}

export class Ipc {
  readonly #subscriptions = new Map<string, Set<Subscription>>();
  readonly #dmesg: DmesgEntry[] = [];
  #nextMessageSeq = 1;
  #nextDmesgSeq = 1;
  #dmesgIndex = 0;
  #dmesgSnapshot: readonly DmesgEntry[] | undefined;

  subscribe(topic: string, ownerId: string, ownerPid: PID | null, handler: IpcHandler): () => void {
    const subscription = { ownerId, ownerPid, handler };
    let subscribers = this.#subscriptions.get(topic);
    if (!subscribers) {
      subscribers = new Set();
      this.#subscriptions.set(topic, subscribers);
    }
    subscribers.add(subscription);

    return () => {
      if (subscribers.delete(subscription) && subscribers.size === 0) this.#subscriptions.delete(topic);
    };
  }

  unsubscribeByOwner(ownerId: string): void {
    for (const [topic, subscribers] of this.#subscriptions) {
      for (const subscription of subscribers) {
        if (subscription.ownerId === ownerId) subscribers.delete(subscription);
      }
      if (subscribers.size === 0) this.#subscriptions.delete(topic);
    }
  }

  publish(
    topic: string,
    senderId: string,
    senderPid: PID | null,
    payload: unknown,
    timestampMs: number,
    isOwnerSuspended: (pid: PID) => boolean,
  ): IpcMessage {
    const message = Object.freeze({ seq: this.#nextMessageSeq++, topic, senderId, senderPid, timestampMs, payload });
    const subscribers = this.#subscriptions.get(topic);
    if (!subscribers) return message;

    for (const subscription of [...subscribers]) {
      if (!subscribers.has(subscription)) continue;
      if (subscription.ownerPid !== null && isOwnerSuspended(subscription.ownerPid)) continue;

      try {
        subscription.handler(message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : `Subscriber failed on ${topic}.`;
        this.writeDmesg(timestampMs, 'error', subscription.ownerId, 'ipc.handler-error', detail);
      }
    }
    return message;
  }

  writeDmesg(timestampMs: number, level: DmesgLevel, source: string, event: string, detail?: string): DmesgEntry {
    const entry = Object.freeze({
      seq: this.#nextDmesgSeq++,
      timestampMs,
      level,
      source,
      event,
      ...(detail === undefined ? {} : { detail }),
    });
    this.#dmesg[this.#dmesgIndex] = entry;
    this.#dmesgIndex = (this.#dmesgIndex + 1) % DMESG_LIMIT;
    this.#dmesgSnapshot = undefined;
    return entry;
  }

  getDmesg(): readonly DmesgEntry[] {
    if (!this.#dmesgSnapshot) {
      const first = this.#dmesg.length < DMESG_LIMIT ? 0 : this.#dmesgIndex;
      this.#dmesgSnapshot = Object.freeze([...this.#dmesg.slice(first), ...this.#dmesg.slice(0, first)]);
    }
    return this.#dmesgSnapshot;
  }
}
