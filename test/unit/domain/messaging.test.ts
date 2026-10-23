import { describe, expect, test } from 'bun:test';
import { WalletOpened } from '../../../src/domain/events/wallet-events';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { t0, walletWith } from './wager-fixtures';

const ctx = { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: t0 };

describe('InboxMessage', () => {
  test('is received unprocessed and can be marked processed once settled', () => {
    const msg = InboxMessage.receive({ messageId: 'm-1', consumerName: 'c', payloadHash: 'h', receivedAt: t0 });
    expect(msg.isProcessed()).toBe(false);

    msg.markProcessed(t0);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(t0);
  });
});

describe('OutboxMessage', () => {
  test('uses the event id as its id and stores the serialized envelope', () => {
    const evt = WalletOpened.from(walletWith('0.00'), ctx);
    const msg = OutboxMessage.enqueue(evt);

    expect(msg.id).toBe('evt-1');
    expect(msg.eventType).toBe('WalletOpened');
    expect(msg.aggregateId).toBe('wallet-1');
    expect(msg.payload).toEqual(evt.toJSON());
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(t0)).toBe(true);
  });

  test('backs off exponentially and caps at five minutes', () => {
    const msg = OutboxMessage.enqueue(WalletOpened.from(walletWith('0.00'), ctx));

    msg.scheduleRetry(t0);
    msg.scheduleRetry(t0);
    msg.scheduleRetry(t0);
    expect(msg.attempts).toBe(3);
    expect(msg.nextAttemptAt).toEqual(new Date(t0.getTime() + 8_000));
    expect(msg.isDue(t0)).toBe(false);

    for (let i = 0; i < 20; i += 1) msg.scheduleRetry(t0);
    expect(msg.nextAttemptAt).toEqual(new Date(t0.getTime() + 300_000));
  });

  test('is no longer pending once published', () => {
    const msg = OutboxMessage.enqueue(WalletOpened.from(walletWith('0.00'), ctx));
    msg.markPublished(t0);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(t0)).toBe(false);
    expect(msg.publishedAt).toEqual(t0);
  });
});
