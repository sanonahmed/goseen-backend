import {
  Injectable,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { verifyAdMobSsvSignature } from './admob-ssv.util';

// Economy constants — keep in sync with client CreditEconomy class
const MAX_ADS_PER_DAY = 15;
const AD_COOLDOWN_SECONDS = 30;
const PREMIUM_COSTS: Record<number, number> = { 1: 100, 7: 600, 30: 2200, 90: 6000 };
const STREAK_BONUSES: Record<number, number> = { 3: 25, 7: 75, 14: 150, 30: 400, 100: 1500 };

function creditsForAd(n: number): number {
  if (n <= 5) return 10;
  if (n <= 10) return 7;
  return 5;
}

@Injectable()
export class CreditsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private async ensureRow(userId: string) {
    await this.pool.query(
      `INSERT INTO user_credits (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const { rows } = await this.pool.query(
      `SELECT * FROM user_credits WHERE user_id = $1`,
      [userId],
    );
    return rows[0];
  }

  async getMe(userId: string) {
    const row = await this.ensureRow(userId);
    const { rows: txs } = await this.pool.query(
      `SELECT id, amount, type, description, created_at
       FROM credit_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId],
    );
    return {
      balance: row.balance,
      lifetime_earned: row.lifetime_earned,
      ads_watched_today: row.ads_watched_today,
      streak_days: row.streak_days,
      cooldown_until: row.cooldown_until,
      premium_expires_at: row.premium_expires_at,
      recent_transactions: txs,
    };
  }

  // ── AdMob Server-Side Verification ───────────────────────────────────────
  //
  // The client never gets to grant itself credits. Google's ad servers POST
  // (well, GET) a signed callback to this endpoint once a rewarded ad has
  // genuinely played to completion; we verify that signature, dedupe by
  // Google's transaction_id, and only then run the same economy logic that
  // used to be triggered directly by the client.
  //
  // `queryString` is the raw, still-URL-encoded query string from the
  // incoming request — required as-is for signature verification.
  async handleSsvCallback(queryString: string): Promise<{ ok: boolean }> {
    const valid = await verifyAdMobSsvSignature(queryString);
    if (!valid) return { ok: false };

    const params = new URLSearchParams(queryString);
    const transactionId = params.get('transaction_id');
    const userId = params.get('user_id');
    if (!transactionId || !userId) return { ok: false };

    // Idempotency: a unique-constraint violation here means this exact ad
    // view was already processed (Google may retry callbacks), so we just
    // acknowledge without granting a second time.
    const inserted = await this.pool.query(
      `INSERT INTO ad_ssv_transactions (transaction_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (transaction_id) DO NOTHING
       RETURNING transaction_id`,
      [transactionId, userId],
    );
    if (inserted.rowCount === 0) return { ok: true };

    try {
      await this.grantAdReward(userId);
      await this.pool.query(
        `UPDATE ad_ssv_transactions SET granted = TRUE WHERE transaction_id = $1`,
        [transactionId],
      );
    } catch {
      // Economy rules (cooldown / daily limit) rejected the grant — the ad
      // view is still marked processed so a retried callback can't retry it.
    }
    return { ok: true };
  }

  /// Polled by the client after watching an ad. Reports whether a reward
  /// transaction has landed for this user since `since` yet.
  async getAdRewardStatus(userId: string, since: Date) {
    const { rows } = await this.pool.query(
      `SELECT amount, type FROM credit_transactions
       WHERE user_id = $1 AND created_at >= $2 AND type IN ('ad', 'streak')
       ORDER BY created_at ASC`,
      [userId, since.toISOString()],
    );
    if (rows.length === 0) return { pending: true };

    const row = await this.ensureRow(userId);
    const earned = rows
      .filter((r) => r.type === 'ad')
      .reduce((sum, r) => sum + (r.amount as number), 0);
    const streakBonus = rows
      .filter((r) => r.type === 'streak')
      .reduce((sum, r) => sum + (r.amount as number), 0);

    return {
      pending: false,
      earned,
      streak_bonus: streakBonus,
      balance: row.balance,
      lifetime_earned: row.lifetime_earned,
      ads_watched_today: row.ads_watched_today,
      streak_days: row.streak_days,
      cooldown_until: row.cooldown_until,
    };
  }

  private async grantAdReward(userId: string) {
    const row = await this.ensureRow(userId);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    if (row.cooldown_until && new Date(row.cooldown_until) > now) {
      throw new BadRequestException('Cooldown active');
    }

    const adDate = row.ad_date ? String(row.ad_date).slice(0, 10) : null;
    const adsToday = adDate === todayStr ? (row.ads_watched_today as number) : 0;
    if (adsToday >= MAX_ADS_PER_DAY) {
      throw new BadRequestException('Daily ad limit reached');
    }

    const adNumber = adsToday + 1;
    const earned = creditsForAd(adNumber);
    const cooldownUntil = new Date(now.getTime() + AD_COOLDOWN_SECONDS * 1000);

    // Streak: increment if first activity of a new consecutive day
    const lastActivity = row.last_activity ? String(row.last_activity).slice(0, 10) : null;
    let newStreak: number = row.streak_days as number;
    if (lastActivity !== todayStr) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      newStreak =
        lastActivity === yesterday.toISOString().slice(0, 10) ? newStreak + 1 : 1;
    }

    let newBalance = (row.balance as number) + earned;
    let newLifetime = (row.lifetime_earned as number) + earned;

    await this.pool.query(
      `UPDATE user_credits SET
         balance = $1, lifetime_earned = $2, ads_watched_today = $3,
         ad_date = $4::date, streak_days = $5, last_activity = $4::date,
         cooldown_until = $6, updated_at = NOW()
       WHERE user_id = $7`,
      [newBalance, newLifetime, adNumber, todayStr, newStreak,
       cooldownUntil.toISOString(), userId],
    );
    await this.pool.query(
      `INSERT INTO credit_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'ad', $3)`,
      [userId, earned, `Ad reward (ad #${adNumber})`],
    );

    let streakBonus = 0;
    const bonus = STREAK_BONUSES[newStreak];
    if (bonus && newStreak !== (row.streak_days as number)) {
      streakBonus = bonus;
      newBalance += bonus;
      newLifetime += bonus;
      await this.pool.query(
        `UPDATE user_credits SET balance = $1, lifetime_earned = $2, updated_at = NOW()
         WHERE user_id = $3`,
        [newBalance, newLifetime, userId],
      );
      await this.pool.query(
        `INSERT INTO credit_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'streak', $3)`,
        [userId, bonus, `${newStreak}-day streak bonus`],
      );
    }

    return {
      earned,
      balance: newBalance,
      lifetime_earned: newLifetime,
      streak_days: newStreak,
      streak_bonus: streakBonus,
      cooldown_until: cooldownUntil.toISOString(),
    };
  }

  async redeemPremium(userId: string, days: number) {
    const cost = PREMIUM_COSTS[days];
    if (!cost) throw new BadRequestException('Invalid plan (valid: 1, 7, 30, 90)');

    const row = await this.ensureRow(userId);
    if ((row.balance as number) < cost) throw new BadRequestException('Insufficient credits');

    const now = new Date();
    const base =
      row.premium_expires_at && new Date(row.premium_expires_at) > now
        ? new Date(row.premium_expires_at)
        : now;
    const expiresAt = new Date(base.getTime() + days * 86_400_000);
    const newBalance = (row.balance as number) - cost;

    await this.pool.query(
      `UPDATE user_credits SET balance = $1, premium_expires_at = $2, updated_at = NOW()
       WHERE user_id = $3`,
      [newBalance, expiresAt.toISOString(), userId],
    );
    await this.pool.query(
      `INSERT INTO credit_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'redemption', $3)`,
      [userId, -cost, `Redeemed ${days}-day Premium`],
    );

    return { balance: newBalance, premium_expires_at: expiresAt.toISOString() };
  }
}
