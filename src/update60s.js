// 移除所有 storage/TypeScript 相关导入
import puppeteer from 'puppeteer';
import { Octokit } from '@octokit/rest';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

// 初始化GitHub API客户端
const octokit = new Octokit({ auth: process.env.GH_TOKEN });

// GitHub仓库配置
const REPO_CONFIG = {
  owner: process.env.REPO_OWNER,
  repo: process.env.REPO_NAME,
  branch: process.env.BRANCH || 'main',
  path: 'static/images/'
};

// 目标API地址
const API_URL = 'https://60s.viki.moe/v2/60s';

// 校验环境变量
if (!process.env.GH_TOKEN || !REPO_CONFIG.owner || !REPO_CONFIG.repo) {
  console.error('缺少环境变量：GH_TOKEN/REPO_OWNER/REPO_NAME');
  process.exit(1);
}

// 入口函数
async function update60s() {
  // 无需处理inputDate，直接获取API当日数据
  console.log('开始从API获取60s数据...');

  // 从API获取数据（封装为函数，增加重试）
  async function fetch60sData() {
    let retries = 3;
    while (retries > 0) {
      try {
        const response = await fetch(API_URL, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://60s.viki.moe/',
            'Accept': 'application/json, text/plain, */*',
            'Cache-Control': 'no-cache'
          },
          timeout: 10000
        });

        if (!response.ok) throw new Error(`API请求失败：${response.status} ${response.statusText}`);
        const apiData = await response.json();
        
        // 校验核心数据
        if (!apiData.data || !apiData.data.date || !Array.isArray(apiData.data.news)) {
          throw new Error('API返回数据结构异常，缺少date/news字段');
        }
        return apiData.data;
      } catch (err) {
        retries--;
        if (retries === 0) throw err;
        console.log(`API请求失败，重试(${3 - retries}/3)...`, err.message);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  // 核心逻辑：获取API数据 → 生成图片 → 上传GitHub
  try {
    // 1. 获取API数据
    const apiData = await fetch60sData();
    console.log(`成功获取${apiData.date}的60s数据，共${apiData.news.length}条新闻`);

    // 2. 生成图片（无头浏览器）
    const imageBase64 = await generateImage(apiData);
    const imageBuffer = Buffer.from(imageBase64.split(',')[1], 'base64');
    const fileName = `${apiData.date}.png`;

    // 3. 上传到GitHub
    await uploadToGitHub(fileName, imageBuffer);
    console.log(`✅ 成功上传图片到GitHub：${REPO_CONFIG.path}${fileName}`);

  } catch (err) {
    console.error('❌ 执行失败：', err.message);
    process.exit(1);
  }
}

/**
 * 生成图片（无头浏览器运行template.html）
 */
async function generateImage(data) {
  let browser;
  try {
    // 启动无头浏览器
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox', // GitHub Actions必须加
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
      headless: 'new'
    });

    const page = await browser.newPage();
    // 加载本地template.html
    const templatePath = path.resolve(process.cwd(), 'src/template.html');
    await page.goto(`file://${templatePath}`, { waitUntil: 'domcontentloaded' });

    // 注入数据到页面
    await page.evaluate((injectData) => {
      window.DATA = injectData;
    }, data);

    // 等待图片生成完成（最多30秒）
    const imageBase64 = await page.waitForFunction(() => {
      return window.IMAGE_BASE64 || (window.IMAGE_ERROR && Promise.reject(window.IMAGE_ERROR));
    }, { timeout: 30000 });

    return imageBase64.jsonValue();

  } finally {
    if (browser) await browser.close();
  }
}

/**
 * 上传图片到GitHub仓库
 */
async function uploadToGitHub(fileName, fileBuffer) {
  const filePath = `${REPO_CONFIG.path}${fileName}`;

  try {
    // 先检查文件是否存在（获取sha）
    const existingFile = await octokit.rest.repos.getContent({
      owner: REPO_CONFIG.owner,
      repo: REPO_CONFIG.repo,
      path: filePath,
      ref: REPO_CONFIG.branch
    }).catch(() => null); // 不存在则返回null

    // 上传/更新文件
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: REPO_CONFIG.owner,
      repo: REPO_CONFIG.repo,
      path: filePath,
      message: `Auto update 60s image: ${fileName}`,
      content: fileBuffer.toString('base64'),
      branch: REPO_CONFIG.branch,
      ...(existingFile ? { sha: existingFile.data.sha } : {}) // 存在则更新，不存在则创建
    });
  } catch (err) {
    throw new Error(`上传GitHub失败：${err.message}`);
  }
}

// 执行入口函数
update60s();
