import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { ApiKey, InsertableApiKey } from '@docmost/db/types/entity.types';

const listFields = [
  'id',
  'name',
  'creatorId',
  'workspaceId',
  'expiresAt',
  'lastUsedAt',
  'createdAt',
] as const;

export type ApiTokenSummary = Pick<ApiKey, (typeof listFields)[number]>;

@Injectable()
export class ApiTokenRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async insert(row: InsertableApiKey): Promise<ApiKey> {
    return this.db
      .insertInto('apiKeys')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findActiveById(id: string): Promise<ApiKey | undefined> {
    return this.db
      .selectFrom('apiKeys')
      .selectAll()
      .where('id', '=', id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async listByCreator(
    creatorId: string,
    workspaceId: string,
  ): Promise<ApiTokenSummary[]> {
    return this.db
      .selectFrom('apiKeys')
      .select(listFields)
      .where('creatorId', '=', creatorId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  async revoke(id: string): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ lastUsedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }
}
