/**
 * Decentralized Social Platform
 * 
 * Core module for storing and retrieving posts with
 * blockchain-based persistence and IPFS content storage.
 */

const { ethers } = require('ethers');
const { create } = require('ipfs-http-client');
const { Buffer } = require('buffer');

class DecentralizedPostStore {
  constructor(config = {}) {
    // Initialize blockchain provider
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    
    // Initialize IPFS client
    this.ipfs = create({
      host: config.ipfsHost || 'ipfs.infura.io',
      port: config.ipfsPort || 5001,
      protocol: config.ipfsProtocol || 'https'
    });
    
    // Connect to social media contract
    this.contractAddress = config.contractAddress;
    this.contractAbi = require('./abi/SocialMediaContract.json');
    this.contract = new ethers.Contract(
      this.contractAddress,
      this.contractAbi,
      this.provider
    );
    
    // Cache for frequently accessed posts
    this.postCache = new Map();
  }
  
  // Store content on IPFS
  async storeContent(content) {
    const contentBuffer = Buffer.from(JSON.stringify(content));
    const result = await this.ipfs.add(contentBuffer);
    return result.path;
  }
  
  // Create a new post
  async createPost(params) {
    const { content, attachments = [], replyTo = null, wallet } = params;
    
    try {
      // Store post content on IPFS
      const contentCid = await this.storeContent({
        text: content,
        attachments,
        timestamp: Date.now()
      });
      
      // Create transaction to store post reference on blockchain
      const connectedContract = this.contract.connect(wallet);
      const tx = await connectedContract.createPost(
        contentCid,
        replyTo || ethers.constants.HashZero
      );
      
      // Wait for transaction confirmation
      const receipt = await tx.wait();
      
      // Extract post ID from event
      const event = receipt.events.find(e => e.event === 'PostCreated');
      const postId = event.args.postId;
      
      return {
        success: true,
        postId,
        contentCid,
        transactionHash: receipt.transactionHash
      };
    } catch (error) {
      console.error('Error creating post:', error);
      return { success: false, error: error.message };
    }
  }
  
  // Get post by ID
  async getPost(postId) {
    try {
      // Check cache first
      if (this.postCache.has(postId)) {
        return this.postCache.get(postId);
      }
      
      // Get post metadata from blockchain
      const postData = await this.contract.getPost(postId);
      
      // Get content from IPFS
      const contentCid = postData.contentCid;
      let content = '';
      for await (const chunk of this.ipfs.cat(contentCid)) {
        content += chunk.toString();
      }
      const parsedContent = JSON.parse(content);
      
      // Create full post object
      const post = {
        id: postId,
        author: postData.author,
        content: parsedContent.text,
        attachments: parsedContent.attachments,
        timestamp: parsedContent.timestamp,
        replyTo: postData.replyTo,
        likes: postData.likeCount.toNumber(),
        reposts: postData.repostCount.toNumber()
      };
      
      // Update cache
      this.postCache.set(postId, post);
      
      return post;
    } catch (error) {
      console.error(`Error fetching post ${postId}:`, error);
      throw new Error(`Failed to fetch post: ${error.message}`);
    }
  }
  
  // Get a user's feed
  async getFeed(address, options = {}) {
    const { limit = 20, cursor = null } = options;
    
    try {
      // Get followed accounts from blockchain
      const following = await this.contract.getFollowing(address);
      
      // Add user's own address to get their posts too
      const accounts = [...following, address];
      
      // Get post IDs from these accounts
      const postIds = await this.contract.getPostsByAuthors(
        accounts, 
        limit, 
        cursor || ethers.constants.HashZero
      );
      
      // Fetch full posts
      const posts = await Promise.all(
        postIds.map(id => this.getPost(id))
      );
      
      // Sort by timestamp, newest first
      return posts.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error(`Error fetching feed for ${address}:`, error);
      throw new Error(`Failed to fetch feed: ${error.message}`);
    }
  }
  
  // Like a post
  async likePost(postId, wallet) {
    try {
      const connectedContract = this.contract.connect(wallet);
      const tx = await connectedContract.likePost(postId);
      const receipt = await tx.wait();
      
      // Clear cache for this post
      this.postCache.delete(postId);
      
      return {
        success: true,
        transactionHash: receipt.transactionHash
      };
    } catch (error) {
      console.error(`Error liking post ${postId}:`, error);
      return { success: false, error: error.message };
    }
  }
  
  // Follow an account
  async followAccount(address, wallet) {
    try {
      const connectedContract = this.contract.connect(wallet);
      const tx = await connectedContract.follow(address);
      const receipt = await tx.wait();
      
      return {
        success: true,
        transactionHash: receipt.transactionHash
      };
    } catch (error) {
      console.error(`Error following ${address}:`, error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = DecentralizedPostStore;
