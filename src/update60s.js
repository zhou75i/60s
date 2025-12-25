import puppeteer from 'puppeteer';
import { Octokit } from '@octokit/rest';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// 初始化GitHub客户端
const octokit = new Octokit({ auth: process.env.GH_TOKEN });

// GitHub配置
const REPO_CONFIG = {
  owner: process.env.REPO_OWNER,
  repo: process.env.REPO_NAME,
  branch: process.env.BRANCH || 'main',
  path: 'static/images/'
};

// API地址
const API_URL = 'https://60s.viki.moe/v2/60s';

// 校验环境变量
if (!process.env.GH_TOKEN || !REPO_CONFIG.owner || !REPO_CONFIG.repo) {
  console.error('缺少环境变量：GH_TOKEN/REPO_OWNER/REPO_NAME');
  process.exit(1);
}

// 入口函数
async function update60s() {
  // 获取API数据（带重试）
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

  try {
    // 1. 获取API数据
    const apiData = await fetch60sData();
    console.log(`成功获取${apiData.date}的60s数据，共${apiData.news.length}条新闻`);

    // 2. 生成图片
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
 * 生成图片（适配新的generate逻辑）
 */
async function generateImage(data) {
  let browser;
  try {
    console.log('启动无头浏览器...');
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--allow-file-access-from-files',
        '--disable-web-security', // 关闭跨域限制（关键：加载GitHub图片）
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      headless: 'new',
      defaultViewport: { 
        width: 1080,  // 适配Banner图片宽度
        height: 6000,
        deviceScaleFactor: 2 // 提高分辨率
      },
      timeout: 60000
    });

    const page = await browser.newPage();

    // 捕获页面日志（调试用）
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      console.log(`[页面${type}] ${text}`);
    });
    page.on('pageerror', (err) => {
      console.error(`[页面错误] ${err.message}`);
      page.evaluate((errorMsg) => {
        window.IMAGE_ERROR = errorMsg;
      }, err.message);
    });

    // 加载模板页面
    const templatePath = path.resolve(process.cwd(), 'src/template.html');
    console.log(`加载模板文件：${templatePath}`);
    await page.goto(`file://${templatePath}`, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // 注入数据
    console.log('注入数据到页面...');
    await page.evaluate((injectData) => {
      window.DATA = injectData;
    }, data);

    // 触发绘制（等待异步完成：字体加载+图片加载）
    console.log('触发页面绘制...');
    await page.evaluate(async () => {
      if (typeof generate === 'function') {
        await generate(); // 等待异步绘制完成
      } else {
        throw new Error('页面未找到generate函数');
      }
    });

    // 等待图片生成（延长超时，适配字体+图片加载）
    console.log('等待图片生成...');
    const imageBase64 = await page.waitForFunction(() => {
      if (window.IMAGE_ERROR) throw new Error(window.IMAGE_ERROR);
      return window.IMAGE_BASE64;
    }, { 
      timeout: 180000, // 延长到3分钟
      polling: 1000
    });

    // 调试信息
    const canvasInfo = await page.evaluate(() => {
      return {
        base64Length: window.IMAGE_BASE64.length,
        error: window.IMAGE_ERROR || '无'
      };
    });
    console.log(`图片生成完成，Base64长度：${canvasInfo.base64Length}`);

    return imageBase64.jsonValue();

  } catch (err) {
    throw new Error(`图片生成失败：${err.message}`);
  } finally {
    if (browser) {
      console.log('关闭无头浏览器...');
      await browser.close();
    }
  }
}

/**
 * 上传图片到GitHub
 */
async function uploadToGitHub(fileName, fileBuffer) {
  const filePath = `${REPO_CONFIG.path}${fileName}`;

  try {
    // 检查文件是否存在
    const existingFile = await octokit.rest.repos.getContent({
      owner: REPO_CONFIG.owner,
      repo: REPO_CONFIG.repo,
      path: filePath,
      ref: REPO_CONFIG.branch
    }).catch(() => null);

    // 上传/更新文件
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: REPO_CONFIG.owner,
      repo: REPO_CONFIG.repo,
      path: filePath,
      message: `Auto update 60s image: ${fileName}`,
      content: fileBuffer.toString('base64'),
      branch: REPO_CONFIG.branch,
      ...(existingFile ? { sha: existingFile.data.sha } : {})
    });
  } catch (err) {
    throw new Error(`上传GitHub失败：${err.message}`);
  }
}

// 执行入口
update60s();
