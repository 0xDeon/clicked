import redisClient from '../config/redis.js';

/**
 * Retrieves the cached conversation list for a specific user.
 * * @param {string} userId - The unique identifier of the user.
 * @returns {Promise<Array|null>} Sanitized conversation array or null on cache miss.
 */
async function getConversationList(userId) {
  const cacheKey = `user:${userId}:conversations`;
  const cachedData = await redisClient.get(cacheKey);
  return cachedData ? JSON.parse(cachedData) : null;
}

/**
 * Commits a full, pre-sanitized conversation list to the Redis cache.
 * * @param {string} userId - The unique identifier of the user.
 * @param {Array} conversations - Sanitized conversation objects.
 */
async function setConversationList(userId, conversations) {
  const cacheKey = `user:${userId}:conversations`;
  // Cache data with a standard 24-hour expiration safety window
  await redisClient.set(cacheKey, JSON.stringify(conversations), 'EX', 86400);
}

/**
 * Updates a singular conversation entry cache tracking shape securely.
 * Called automatically when real-time messages are broadcasted across sockets.
 * * Acceptance Criteria Met:
 * - Drops structural message body/text/ciphertext fragments.
 * - Retains only isolated metadata fields (senderId, senderDeviceId, contentType, sequenceNumber, createdAt).
 */
async function updateConversationCache(userId, conversationId, lastMessagePayload, unreadCount) {
  const cacheKey = `user:${userId}:conversations`;
  
  // 1. Fetch the existing cache array list
  const cachedData = await redisClient.get(cacheKey);
  let list = cachedData ? JSON.parse(cachedData) : [];

  // 2. Find if the target conversation context already exists in the array
  let convItem = list.find(c => c.id === conversationId);
  
  // 3. SECURE PREVIEW ISOLATION MATRIX
  // Manually map out the verified unclassified attributes. 
  // CRITICAL: Never spread (...lastMessagePayload) as it risks inheriting forbidden message bodies.
  const sanitizedMessageMetadata = lastMessagePayload ? {
    senderId: lastMessagePayload.senderId,
    senderDeviceId: lastMessagePayload.senderDeviceId,
    contentType: lastMessagePayload.contentType,
    sequenceNumber: lastMessagePayload.sequenceNumber,
    createdAt: lastMessagePayload.createdAt
  } : null;

  const currentTimestamp = lastMessagePayload?.createdAt || new Date().toISOString();

  if (convItem) {
    // 4a. Update reference nodes on existing entry
    convItem.unreadCount = unreadCount;
    convItem.lastMessage = sanitizedMessageMetadata;
    convItem.updatedAt = currentTimestamp;
  } else {
    // 4b. Push a brand new sanitized profile block if conversation entry is new
    list.push({
      id: conversationId,
      participants: [], // Will be hydrated on full sync
      unreadCount: unreadCount,
      lastMessage: sanitizedMessageMetadata,
      updatedAt: currentTimestamp
    });
  }

  // 5. Keep the conversation feed list sorted perfectly by latest updates (Ordering Requirement)
  list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  // 6. Save back to the Redis database instances
  await redisClient.set(cacheKey, JSON.stringify(list), 'EX', 86400);
}

const cacheService = {
  getConversationList,
  setConversationList,
  updateConversationCache
};

export { getConversationList, setConversationList, updateConversationCache };
export default cacheService;