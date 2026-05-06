import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { usersTable, referralsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { logger } from "./logger";

const token = process.env["TELEGRAM_BOT_TOKEN"];
const ADMIN_TELEGRAM_ID = process.env["ADMIN_TELEGRAM_ID"] ?? "";
const CHANNEL_USERNAME = "@rostovlegends";
const STARS_PER_REFERRAL = 1;
const MIN_REFERRALS_FOR_PAYOUT = 50;
const MAX_STARS = 50;

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

export const bot = new TelegramBot(token, { polling: true });

function isAdmin(telegramId: string): boolean {
  return ADMIN_TELEGRAM_ID !== "" && telegramId === ADMIN_TELEGRAM_ID;
}

function generateReferralCode(telegramId: string): string {
  return `ref_${telegramId}_${Math.random().toString(36).substring(2, 7)}`;
}

function progressBar(current: number, total: number, length = 10): string {
  const filled = Math.round((Math.min(current, total) / total) * length);
  return "█".repeat(filled) + "░".repeat(length - filled);
}

async function isSubscribed(telegramId: string): Promise<boolean> {
  try {
    const member = await bot.getChatMember(CHANNEL_USERNAME, parseInt(telegramId));
    return ["member", "administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

// Античит: перепроверяет всех приглашённых пользователем и убирает тех кто отписался
async function revalidateReferrals(inviterTelegramId: string): Promise<number> {
  const referrals = await db
    .select()
    .from(referralsTable)
    .where(eq(referralsTable.inviterTelegramId, inviterTelegramId));

  let removed = 0;
  for (const ref of referrals) {
    const stillSubscribed = await isSubscribed(ref.inviteeTelegramId);
    if (!stillSubscribed) {
      await db
        .delete(referralsTable)
        .where(eq(referralsTable.inviteeTelegramId, ref.inviteeTelegramId));
      removed++;
      logger.info({ inviter: inviterTelegramId, invitee: ref.inviteeTelegramId }, "Referral removed: unsubscribed");
    }
  }

  if (removed > 0) {
    // Пересчитываем актуальное кол-во рефералов из таблицы
    const [count] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(referralsTable)
      .where(eq(referralsTable.inviterTelegramId, inviterTelegramId));

    const newCount = count?.c ?? 0;
    const newStars = Math.min(newCount * STARS_PER_REFERRAL, MAX_STARS);

    await db
      .update(usersTable)
      .set({ referralCount: newCount, starsEarned: newStars })
      .where(eq(usersTable.telegramId, inviterTelegramId));
  }

  return removed;
}

async function notifyAdmin(text: string): Promise<void> {
  if (!ADMIN_TELEGRAM_ID) return;
  try {
    await bot.sendMessage(ADMIN_TELEGRAM_ID, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "Failed to notify admin");
  }
}

async function tryAutoSendStars(telegramId: string, starCount: number): Promise<boolean> {
  try {
    await (bot as any).request("sendGift", {
      user_id: parseInt(telegramId),
      star_count: starCount,
    });
    return true;
  } catch {
    return false;
  }
}

async function getOrCreateUser(
  telegramId: string,
  firstName?: string,
  username?: string,
  referredBy?: string,
): Promise<typeof usersTable.$inferSelect> {
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId));

  if (existing[0]) return existing[0];

  const referralCode = generateReferralCode(telegramId);

  const [user] = await db
    .insert(usersTable)
    .values({
      telegramId,
      firstName: firstName ?? null,
      username: username ?? null,
      referralCode,
      referredBy: referredBy ?? null,
    })
    .returning();

  if (referredBy && referredBy !== telegramId) {
    const [inviter] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.telegramId, referredBy));

    if (inviter) {
      const alreadyReferred = await db
        .select()
        .from(referralsTable)
        .where(eq(referralsTable.inviteeTelegramId, telegramId));

      if (!alreadyReferred[0]) {
        // Проверяем подписку нового пользователя
        const subscribed = await isSubscribed(telegramId);
        if (subscribed) {
          await db.insert(referralsTable).values({
            inviterTelegramId: referredBy,
            inviteeTelegramId: telegramId,
          });

          const newCount = (inviter.referralCount ?? 0) + 1;
          const newStars = Math.min(
            (inviter.starsEarned ?? 0) + STARS_PER_REFERRAL,
            MAX_STARS,
          );

          await db
            .update(usersTable)
            .set({ referralCount: newCount, starsEarned: newStars })
            .where(eq(usersTable.telegramId, referredBy));

          logger.info({ inviter: referredBy, invitee: telegramId }, "Referral counted");

          const left = MIN_REFERRALS_FOR_PAYOUT - newCount;
          await bot.sendMessage(
            referredBy,
            `🎉 *+1 реферал!*\n` +
              `[${progressBar(newCount, MIN_REFERRALS_FOR_PAYOUT)}] ${newCount}/${MIN_REFERRALS_FOR_PAYOUT}\n` +
              `${left > 0 ? `До выплаты ещё *${left}* чел.` : `✅ Цель достигнута! Пиши /pay`}`,
            { parse_mode: "Markdown" },
          );

          if (newCount === MIN_REFERRALS_FOR_PAYOUT) {
            await handlePayoutReached(referredBy, inviter.firstName ?? "друг", newStars - (inviter.starsPaid ?? 0));
          }
        }
      }
    }
  }

  return user!;
}

async function handlePayoutReached(telegramId: string, firstName: string, stars: number): Promise<void> {
  // TODO: здесь будет проверка подписки на спонсора

  const sent = await tryAutoSendStars(telegramId, stars);
  if (sent) {
    await db
      .update(usersTable)
      .set({ starsPaid: sql`${usersTable.starsPaid} + ${stars}` })
      .where(eq(usersTable.telegramId, telegramId));

    await bot.sendMessage(
      telegramId,
      `🏆 *${stars} звёзд зачислены!*\nСпасибо за поддержку канала ${CHANNEL_USERNAME} 🙌`,
      { parse_mode: "Markdown" },
    );
    await notifyAdmin(`✅ Автовыплата: *${firstName}* (\`${telegramId}\`) — *${stars}* ⭐`);
  } else {
    await notifyAdmin(
      `🔔 *Выплата!*\n👤 *${firstName}* \`${telegramId}\`\n⭐ *${stars}* звёзд\n\n/adminpay ${telegramId} ${stars}`,
    );
  }
}

// ─── ПОЛЬЗОВАТЕЛИ ───────────────────────────────────────────────────────────

bot.onText(/\/start(.*)/, async (msg, match) => {
  const telegramId = String(msg.chat.id);
  const firstName = msg.chat.first_name ?? "друг";
  const username = msg.chat.username;
  const param = match?.[1]?.trim() ?? "";

  let referredBy: string | undefined;
  if (param.startsWith("ref_")) {
    const parts = param.split("_");
    if (parts.length >= 2) {
      referredBy = parts[1];
      if (referredBy === telegramId) referredBy = undefined;
    }
  }

  const user = await getOrCreateUser(telegramId, firstName, username, referredBy);
  const botInfo = await bot.getMe();
  const refLink = `https://t.me/${botInfo.username}?start=${user.referralCode}`;

  // Сначала краткое приветствие
  await bot.sendMessage(
    telegramId,
    `👋 *${firstName}*, привет!\n\n` +
      `Зови друзей на канал ${CHANNEL_USERNAME} — получай ⭐ звёзды Telegram!\n\n` +
      `*1 друг = 1 звезда* · Нужно *50 человек* · Макс *50 звёзд*`,
    { parse_mode: "Markdown" },
  );

  // Затем отдельным сообщением — реферальная ссылка крупно
  await bot.sendMessage(
    telegramId,
    `🔗 *Твоя реферальная ссылка:*\n\n${refLink}\n\n` +
      `👆 Скопируй и кидай везде!\n\n` +
      `/stats — прогресс · /help — помощь`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📊 Моя статистика", callback_data: "stats" }],
          [{ text: "📢 Поделиться ссылкой", switch_inline_query: refLink }],
        ],
      },
    },
  );
});

bot.onText(/\/stats/, async (msg) => {
  const telegramId = String(msg.chat.id);
  await sendStats(telegramId);
});

bot.on("callback_query", async (query) => {
  const telegramId = String(query.from.id);
  if (query.data === "stats") {
    await sendStats(telegramId);
    await bot.answerCallbackQuery(query.id);
  }
});

async function sendStats(telegramId: string): Promise<void> {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId));

  if (!user) {
    await bot.sendMessage(telegramId, "Напиши /start чтобы начать.");
    return;
  }

  // Античит: перепроверяем рефералов
  const removed = await revalidateReferrals(telegramId);

  // Перечитываем обновлённые данные
  const [fresh] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId));

  if (!fresh) return;

  const botInfo = await bot.getMe();
  const refLink = `https://t.me/${botInfo.username}?start=${fresh.referralCode}`;
  const pending = Math.max(0, (fresh.starsEarned ?? 0) - (fresh.starsPaid ?? 0));
  const count = fresh.referralCount ?? 0;
  const bar = progressBar(count, MIN_REFERRALS_FOR_PAYOUT);
  const canWithdraw = count >= MIN_REFERRALS_FOR_PAYOUT && pending > 0;

  let text =
    `📊 *Статистика*\n\n` +
    `[${bar}] *${count}*/${MIN_REFERRALS_FOR_PAYOUT}\n\n` +
    `👥 Приглашено: *${count}*\n` +
    `⭐ Заработано: *${fresh.starsEarned ?? 0}*\n` +
    `💸 Выплачено: *${fresh.starsPaid ?? 0}*\n\n`;

  if (removed > 0) {
    text += `⚠️ *${removed}* чел. отписались — убраны из счёта\n\n`;
  }

  text += canWithdraw
    ? `✅ *Можно получить ${pending} звёзд!* → /pay`
    : `До выплаты: ещё *${MIN_REFERRALS_FOR_PAYOUT - count}* чел.`;

  text += `\n\n🔗 \`${refLink}\``;

  await bot.sendMessage(telegramId, text, { parse_mode: "Markdown" });
}

bot.onText(/^\/pay$/, async (msg) => {
  const telegramId = String(msg.chat.id);

  // Античит перед выплатой
  await revalidateReferrals(telegramId);

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId));

  if (!user) {
    await bot.sendMessage(telegramId, "Напиши /start чтобы начать.");
    return;
  }

  if (user.referralCount < MIN_REFERRALS_FOR_PAYOUT) {
    await bot.sendMessage(
      telegramId,
      `❌ Нужно *${MIN_REFERRALS_FOR_PAYOUT}* приглашённых.\nСейчас: *${user.referralCount}* / ${MIN_REFERRALS_FOR_PAYOUT}`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  const pending = Math.max(0, (user.starsEarned ?? 0) - (user.starsPaid ?? 0));
  if (pending === 0) {
    await bot.sendMessage(telegramId, "✅ Все звёзды уже выплачены!");
    return;
  }

  // TODO: здесь будет проверка подписки на спонсора

  const sent = await tryAutoSendStars(telegramId, pending);

  if (sent) {
    await db
      .update(usersTable)
      .set({ starsPaid: sql`${usersTable.starsPaid} + ${pending}` })
      .where(eq(usersTable.telegramId, telegramId));

    await bot.sendMessage(
      telegramId,
      `🏆 *${pending} звёзд отправлены!*\nСпасибо за поддержку ${CHANNEL_USERNAME} 🙌`,
      { parse_mode: "Markdown" },
    );
    await notifyAdmin(`✅ Автовыплата: \`${telegramId}\` (${user.firstName}) — *${pending}* ⭐`);
  } else {
    await bot.sendMessage(
      telegramId,
      `⏳ *Запрос на ${pending} звёзд принят!*\nАдмин пришлёт звёзды вручную. 🙏`,
      { parse_mode: "Markdown" },
    );
    await notifyAdmin(
      `🔔 *Выплата!*\n👤 *${user.firstName ?? "—"}* ${user.username ? `@${user.username}` : ""}\n🆔 \`${telegramId}\`\n⭐ *${pending}* звёзд\n\n/adminpay ${telegramId} ${pending}`,
    );
    logger.info({ telegramId, pending }, "Manual payout requested");
  }
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(
    String(msg.chat.id),
    `📋 *Команды:*\n\n` +
      `/start — ссылка и правила\n` +
      `/stats — твой прогресс\n` +
      `/pay — получить звёзды\n` +
      `/help — этот список`,
    { parse_mode: "Markdown" },
  );
});

// ─── АДМИН ──────────────────────────────────────────────────────────────────

bot.onText(/^\/admin$/, async (msg) => {
  const telegramId = String(msg.chat.id);
  if (!isAdmin(telegramId)) { await bot.sendMessage(telegramId, "❌ Нет доступа."); return; }

  const [totals] = await db
    .select({
      totalUsers: sql<number>`count(*)::int`,
      totalReferrals: sql<number>`sum(${usersTable.referralCount})::int`,
      totalEarned: sql<number>`sum(${usersTable.starsEarned})::int`,
      totalPaid: sql<number>`sum(${usersTable.starsPaid})::int`,
    })
    .from(usersTable);

  const [pending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(sql`${usersTable.referralCount} >= ${MIN_REFERRALS_FOR_PAYOUT} AND ${usersTable.starsEarned} > ${usersTable.starsPaid}`);

  await bot.sendMessage(
    telegramId,
    `🛠 *Админ-панель*\n\n` +
      `👥 Пользователей: *${totals?.totalUsers ?? 0}*\n` +
      `🔗 Всего рефералов: *${totals?.totalReferrals ?? 0}*\n` +
      `⭐ Заработано: *${totals?.totalEarned ?? 0}*\n` +
      `💸 Выплачено: *${totals?.totalPaid ?? 0}*\n` +
      `⏳ Ждут выплаты: *${pending?.count ?? 0}* чел.\n\n` +
      `/adminlist · /adminpending · /adminuser <id> · /adminpay <id> <⭐>`,
    { parse_mode: "Markdown" },
  );
});

bot.onText(/^\/adminlist/, async (msg) => {
  const telegramId = String(msg.chat.id);
  if (!isAdmin(telegramId)) { await bot.sendMessage(telegramId, "❌ Нет доступа."); return; }

  const users = await db
    .select()
    .from(usersTable)
    .orderBy(desc(usersTable.referralCount))
    .limit(30);

  if (!users.length) { await bot.sendMessage(telegramId, "Пользователей нет."); return; }

  const lines = users.map((u, i) => {
    const tag = u.username ? ` @${u.username}` : "";
    return `${i + 1}. *${u.firstName ?? "—"}*${tag} — 👥${u.referralCount} ⭐${u.starsEarned} 💸${u.starsPaid}`;
  });

  await bot.sendMessage(telegramId, `📋 *Топ-30:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

bot.onText(/^\/adminpending/, async (msg) => {
  const telegramId = String(msg.chat.id);
  if (!isAdmin(telegramId)) { await bot.sendMessage(telegramId, "❌ Нет доступа."); return; }

  const users = await db
    .select()
    .from(usersTable)
    .where(sql`${usersTable.referralCount} >= ${MIN_REFERRALS_FOR_PAYOUT} AND ${usersTable.starsEarned} > ${usersTable.starsPaid}`)
    .orderBy(desc(usersTable.starsEarned));

  if (!users.length) { await bot.sendMessage(telegramId, "✅ Нет ожидающих выплат."); return; }

  const lines = users.map((u) => {
    const p = (u.starsEarned ?? 0) - (u.starsPaid ?? 0);
    const tag = u.username ? ` @${u.username}` : "";
    return `👤 *${u.firstName ?? "—"}*${tag} \`${u.telegramId}\` — *${p}* ⭐\n/adminpay ${u.telegramId} ${p}`;
  });

  await bot.sendMessage(telegramId, `⏳ *Ждут выплаты (${users.length}):*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
});

bot.onText(/^\/adminuser (.+)/, async (msg, match) => {
  const telegramId = String(msg.chat.id);
  if (!isAdmin(telegramId)) { await bot.sendMessage(telegramId, "❌ Нет доступа."); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, match?.[1]?.trim() ?? ""));
  if (!user) { await bot.sendMessage(telegramId, "Не найден."); return; }

  const pending = (user.starsEarned ?? 0) - (user.starsPaid ?? 0);
  await bot.sendMessage(
    telegramId,
    `👤 *${user.firstName ?? "—"}* ${user.username ? `@${user.username}` : ""}\n` +
      `🆔 \`${user.telegramId}\`\n` +
      `👥 Рефералов: *${user.referralCount}*\n` +
      `⭐ Заработано: *${user.starsEarned}* | 💸 Выплачено: *${user.starsPaid}* | ⏳ Ждёт: *${pending}*\n` +
      `📅 ${user.createdAt.toLocaleDateString("ru-RU")}`,
    { parse_mode: "Markdown" },
  );
});

bot.onText(/^\/adminpay (\S+) (\d+)/, async (msg, match) => {
  const telegramId = String(msg.chat.id);
  if (!isAdmin(telegramId)) { await bot.sendMessage(telegramId, "❌ Нет доступа."); return; }

  const targetId = match?.[1]?.trim() ?? "";
  const stars = parseInt(match?.[2] ?? "0", 10);
  if (!targetId || stars <= 0) { await bot.sendMessage(telegramId, "Формат: /adminpay <id> <звёзд>"); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, targetId));
  if (!user) { await bot.sendMessage(telegramId, "Пользователь не найден."); return; }

  await db
    .update(usersTable)
    .set({ starsPaid: sql`${usersTable.starsPaid} + ${stars}` })
    .where(eq(usersTable.telegramId, targetId));

  await bot.sendMessage(telegramId, `✅ Выплата *${stars}* ⭐ для *${user.firstName ?? targetId}* подтверждена.`, { parse_mode: "Markdown" });
  await bot.sendMessage(targetId, `🏆 *${stars} звёзд зачислены!*\nСпасибо за поддержку ${CHANNEL_USERNAME} 🙌`, { parse_mode: "Markdown" });

  logger.info({ admin: telegramId, target: targetId, stars }, "Manual payout confirmed");
});

// ─── СИСТЕМНЫЕ ──────────────────────────────────────────────────────────────

bot.on("polling_error", (err) => {
  logger.error({ err }, "Telegram polling error");
});

logger.info("Telegram bot started");
