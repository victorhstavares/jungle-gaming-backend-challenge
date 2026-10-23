import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import type { WalletRepository } from '../../../application/ports/repositories';
import { Money } from '../../../domain/money/money';
import { Wallet } from '../../../domain/wallet/wallet';
import { WalletRecord, type WalletRow } from '../records';

const toDomain = (row: WalletRow): Wallet =>
  Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.ofMinor(row.balanceMinor, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row === null ? undefined : toDomain(row);
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRecord, { id }, { disableIdentityMap: true });
    return row === null ? undefined : toDomain(row);
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceMinor: wallet.balance.toMinor(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  }

  async update(wallet: Wallet): Promise<void> {
    await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id },
      { balanceMinor: wallet.balance.toMinor(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
  }
}
