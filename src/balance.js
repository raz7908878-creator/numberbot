const { Redis } = require('@upstash/redis');
require('dotenv').config();

// Default dummy URL to prevent crashes if missing, operations will just fail gracefully
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || 'https://dummy-url.upstash.io',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || 'dummy-token',
});

async function getBalance(chatId) {
  try {
    const key = `balance:${chatId}`;
    const value = await redis.get(key);
    return value !== null ? parseFloat(value) : 0;
  } catch (error) {
    console.error(`[Redis] Error getting balance for ${chatId}:`, error.message);
    return 0;
  }
}

async function setBalance(chatId, amount) {
  try {
    const key = `balance:${chatId}`;
    const newAmount = Math.round(amount * 100) / 100;
    await redis.set(key, newAmount);
    return newAmount;
  } catch (error) {
    console.error(`[Redis] Error setting balance for ${chatId}:`, error.message);
    return Math.round(amount * 100) / 100;
  }
}

async function addBalance(chatId, amount) {
  try {
    const key = `balance:${chatId}`;
    const current = await getBalance(chatId);
    const newAmount = Math.round((current + amount) * 100) / 100;
    await redis.set(key, newAmount);
    return newAmount;
  } catch (error) {
    console.error(`[Redis] Error adding balance for ${chatId}:`, error.message);
    return 0;
  }
}

async function getAllBalances() {
  try {
    const balances = {};
    let cursor = 0;
    let keys = [];
    
    // Upstash REST API returns an array: [nextCursor, [key1, key2...]]
    // We'll just use KEYS command as this is a small bot, but for production
    // redis.keys is simpler via Upstash REST.
    const allKeys = await redis.keys('balance:*');
    
    if (!allKeys || allKeys.length === 0) {
      return balances;
    }
    
    // mget to fetch all at once
    const values = await redis.mget(...allKeys);
    
    for (let i = 0; i < allKeys.length; i++) {
      const chatId = allKeys[i].replace('balance:', '');
      balances[chatId] = parseFloat(values[i]) || 0;
    }
    
    return balances;
  } catch (error) {
    console.error('[Redis] Error getting all balances:', error.message);
    return {};
  }
}

module.exports = {
  getBalance,
  setBalance,
  addBalance,
  getAllBalances
};
