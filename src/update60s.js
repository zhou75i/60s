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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://60s.viki.moe/',
            'Cache-Control': 'no-cache'
          },
          timeout: 10000
        });

        if (!response.ok) throw new Error(`API请求失败：${response.status}`);
        const apiData = await response.json();
        const cleanData = JSON.parse(JSON.stringify(apiData.data));
        
        // 仅保留核心必要数据（移除兜底）
        cleanData.date = cleanData.date;
        cleanData.news = cleanData.news;
        cleanData.lunar_date = cleanData.lunar_date;
        cleanData.tip = cleanData.tip;

        console.log(`✅ API数据校验完成：日期=${cleanData.date}，新闻数=${cleanData.news.length}`);
        return cleanData;
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

    // 3. 上传到GitHub（自动覆盖已有文件）
    await uploadToGitHub(fileName, imageBuffer);
    console.log(`✅ 成功上传（覆盖）图片到GitHub：${REPO_CONFIG.path}${fileName}`);

  } catch (err) {
    console.error('❌ 执行失败：', err.message);
    process.exit(1);
  }
}

/**
 * 生成图片（强化字体加载等待）
 */
async function generateImage(data) {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--allow-file-access-from-files',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      headless: 'new',
      defaultViewport: { 
        width: 1080,
        height: 6000,
        deviceScaleFactor: 2
      },
      timeout: 60000
    });

    const page = await browser.newPage();

    // 捕获页面日志
    page.on('console', msg => console.log(`[页面${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => {
      console.error(`[页面错误] ${err.message}`);
      page.evaluate((errorMsg) => window.IMAGE_ERROR = errorMsg, err.message);
    });

    // 加载模板
    const templatePath = path.resolve(process.cwd(), 'src/template.html');
    await page.goto(`file://${templatePath}`, { waitUntil: 'domcontentloaded' });

    // 注入数据
    const injectDataStr = JSON.stringify(data);
    await page.evaluate((dataStr) => {
      window.DATA = JSON.parse(dataStr);
    }, injectDataStr);

    // 触发绘制并等待完成
    await page.evaluate(async () => {
      if (typeof generate === 'function') {
        await generate();
      } else {
        throw new Error('页面未找到generate函数');
      }
    });

    // 等待图片生成
    const imageBase64 = await page.waitForFunction(() => {
      if (window.IMAGE_ERROR) throw new Error(window.IMAGE_ERROR);
      return window.IMAGE_BASE64;
    }, { timeout: 180000, polling: 1000 });

    // 调试信息
    const canvasInfo = await page.evaluate(() => ({
      base64Length: window.IMAGE_BASE64.length,
      dataNewsLength: window.DATA.news.length
    }));
    console.log(`图片生成完成，Base64长度：${canvasInfo.base64Length}`);

    return imageBase64.jsonValue();

  } catch (err) {
    throw new Error(`图片生成失败：${err.message}`);
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * 上传图片到GitHub（自动覆盖）
 */
async function uploadToGitHub(fileName, fileBuffer) {
  const filePath = `${REPO_CONFIG.path}${fileName}`;

  try {
    // 检查文件是否存在（存在则获取sha用于覆盖）
    const existingFile = await octokit.rest.repos.getContent({
      owner: REPO_CONFIG.owner,
      repo: REPO_CONFIG.repo,
      path: filePath,
      ref: REPO_CONFIG.branch
    }).catch(() => null);

    // 上传/覆盖文件
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: REPO_CONFIG.owner,
      repo: REPO_CONFIG.repo,
      path: filePath,
      message: `Auto update 60s image: ${fileName}`,
      content: fileBuffer.toString('base64'),
      branch: REPO_CONFIG.branch,
      sha: existingFile?.data?.sha // 有sha则覆盖，无则新建
    });
  } catch (err) {
    throw new Error(`上传GitHub失败：${err.message}`);
  }
}

// 执行入口
update60s();
