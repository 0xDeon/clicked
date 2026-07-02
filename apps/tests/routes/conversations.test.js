const request = require('supertest');
// Adjust these absolute/relative path strings to align with your app server config
const app = require('../../src/app'); 
const redisClient = require('../../src/config/redis');

describe('GET /conversations - Ciphertext Safe Metadata Isolation Integration Tests', () => {
  // Clear the redis cache environment variables before each test runs to avoid cross-pollution
  beforeEach(async () => {
    if (redisClient && typeof redisClient.flushall === 'function') {
      await redisClient.flushall();
    }
  });

  // Safe mock JWT signature to bypass access barriers
  const mockAuthToken = 'bearer-mock-jwt-token-string';

  test('should return conversation listings matching safe metadata profiles completely empty of message text bodies', async () => {
    const response = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${mockAuthToken}`)
      .expect(200);

    expect(response.body.success).toBe(true);
    
    const conversations = response.body.data;
    expect(Array.isArray(conversations)).toBe(true);

    // If active seed items exist, cross-examine the structure fields inside lastMessage arrays
    if (conversations.length > 0 && conversations[0].lastMessage) {
      const lastMsg = conversations[0].lastMessage;

      // 1. ACCEPTANCE CRITERIA: Assert ONLY unclassified structural metadata properties exist
      expect(lastMsg).toHaveProperty('senderId');
      expect(lastMsg).toHaveProperty('senderDeviceId');
      expect(lastMsg).toHaveProperty('contentType');
      expect(lastMsg).toHaveProperty('sequenceNumber');
      expect(lastMsg).toHaveProperty('createdAt');

      // 2. PRIVACY SECURE LINE: Assert that content/plaintext/ciphertext values are strictly undefined
      expect(lastMsg.body).toBeUndefined();
      expect(lastMsg.text).toBeUndefined();
      expect(lastMsg.content).toBeUndefined();
      expect(lastMsg.ciphertext).toBeUndefined();
      expect(lastMsg.preview).toBeUndefined();
    }
  });

  test('should maintain conversation counters and ordering keys via top level metadata blocks', async () => {
    const response = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${mockAuthToken}`)
      .expect(200);

    const conversations = response.body.data;
    if (conversations.length > 0) {
      // Unread counters must remain accessible on parent layer to preserve badges functionality
      expect(conversations[0]).toHaveProperty('id');
      expect(conversations[0]).toHaveProperty('unreadCount');
      expect(conversations[0]).toHaveProperty('updatedAt');
      expect(typeof conversations[0].unreadCount).toBe('number');
    }
  });
});