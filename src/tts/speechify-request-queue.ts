import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config';

interface QueuedRequest<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

@Injectable()
export class SpeechifyRequestQueue {
  private readonly minimumStartIntervalMs: number;
  private readonly maximumConcurrency: number;
  private readonly pending: QueuedRequest<unknown>[] = [];
  private active = 0;
  private nextStartAt = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(config: AppConfig) {
    this.minimumStartIntervalMs = Math.ceil(1000 / config.speechifyRequestsPerSecond);
    this.maximumConcurrency = config.speechifyMaxConcurrentRequests;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.drain();
    });
  }

  private drain(): void {
    if (this.active >= this.maximumConcurrency || this.pending.length === 0) return;

    const delay = Math.max(0, this.nextStartAt - Date.now());
    if (delay > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.drain();
        }, delay);
      }
      return;
    }

    const request = this.pending.shift();
    if (!request) return;
    this.active += 1;
    this.nextStartAt = Date.now() + this.minimumStartIntervalMs;

    void Promise.resolve()
      .then(request.task)
      .then(request.resolve, request.reject)
      .finally(() => {
        this.active -= 1;
        this.drain();
      });

    this.drain();
  }
}
