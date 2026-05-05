const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const ChannelSyncService = require('../services/channelSyncService');
const Customer = require('../models/Customer');

router.post('/', [auth, admin], customerController.createCustomer);
router.get('/', [auth, admin], customerController.getCustomers);
router.post('/:customerId/playlists/:playlistId', [auth, admin], customerController.assignPlaylist);
router.delete('/:customerId/playlists/:playlistId', [auth, admin], customerController.removePlaylist);

// Customer app endpoints
router.get('/my-channels', auth, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const syncService = new ChannelSyncService();
    const channels = await syncService.getChannelsForCustomer(req.user.customerId);

    console.log(`Returning ${channels.length} channels to customer`);
    if (channels.length > 0) {
      console.log('Sample channel:', {
        name: channels[0].name,
        hasMacAddress: !!channels[0].macAddress,
        macAddress: channels[0].macAddress,
        playlistType: channels[0].playlistType,
        hasStreamingToken: !!channels[0].streamingToken,
        hasStreamUrl: !!channels[0].streamUrl
      });
    }

    res.json({
      success: true,
      channels
    });
  } catch (error) {
    console.error('Error in /my-channels:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.get('/my-playlists', auth, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const customer = await Customer.findById(req.user.customerId)
      .populate('playlists');

    res.json({
      success: true,
      playlists: customer.playlists
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Add this AFTER your existing routes (around line 40)
router.get('/me', auth, async (req, res) => {
  try {
    // Get the customer ID from the authenticated user
    const customerId = req.user.customerId;
    
    if (!customerId) {
      return res.status(404).json({ 
        success: false, 
        message: 'Customer not found for this user' 
      });
    }
    
    const customer = await Customer.findById(customerId);
    
    if (!customer) {
      return res.status(404).json({ 
        success: false, 
        message: 'Customer not found' 
      });
    }
    
    res.json({
      success: true,
      customer: {
        id: customer._id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        macAddress: customer.macAddress,
        expiryDate: customer.expiryDate,  // ✅ THIS IS WHAT YOU NEED
        status: customer.status,
        playlists: customer.playlists
      }
    });
  } catch (error) {
    console.error('Error in /me:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

module.exports = router;
