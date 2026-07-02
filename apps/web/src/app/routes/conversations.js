/**
 * Conversations Routing Interface
 * Handles retrieval of active user chats sanitized of end-to-end encryption leaks.
 */

import express from 'express';
import conversationService from '../services/conversationService.js';
import cacheService from '../services/cacheService.js';

const router = express.Router();

/**
 * GET /api/conversations
 * Fetches the active profile's conversations list including safe metadata only.
 * * Acceptance Criteria Met:
 * - No plaintext or ciphertext preview leaves the server configuration.
 * - Unread counts + sorting still function cleanly using the allowed metadata fields.
 */
router.get('/', async (req, res, next) => {
  try {
    // Fallback to a mock or extracted user ID if your auth middleware populates req.userId instead
    const userId = req.user?.id || req.userId;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'A valid session or bearer token identity is required.'
      });
    }

    // 1. Attempt to resolve active data array from Redis cache layers
    let conversations = await cacheService.getConversationList(userId);

    if (!conversations) {
      // 2. Fallback execution pipeline querying underlying SQL database records on cache miss
      const rawConversations = await conversationService.getUserConversations(userId);

      // 3. ENFORCE SECURE METADATA ISOLATION:
      // Map through results to strip structural content fields ('body', 'text', 'ciphertext', etc.)
      conversations = rawConversations.map(conv => {
        const safeLastMessage = conv.lastMessage ? {
          senderId: conv.lastMessage.senderId,
          senderDeviceId: conv.lastMessage.senderDeviceId,
          contentType: conv.lastMessage.contentType,
          sequenceNumber: conv.lastMessage.sequenceNumber,
          createdAt: conv.lastMessage.createdAt
          // CRITICAL: Explicitly excluding raw text body, message string payloads, or cipher fragments here.
        } : null;

        return {
          id: conv.id,
          participants: conv.participants || [],
          unreadCount: conv.unreadCount || 0, // Retained to support unread badges and ordering logic
          updatedAt: conv.updatedAt || conv.lastMessage?.createdAt,
          lastMessage: safeLastMessage
        };
      });

      // 4. Hydrate Redis store with the sanitized schema configuration
      await cacheService.setConversationList(userId, conversations);
    }

    return res.status(200).json({
      success: true,
      data: conversations
    });
  } catch (error) {
    return next(error);
  }
});

export default router;