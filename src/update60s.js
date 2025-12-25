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
        const cleanData = JSON.parse(JSON.stringify(apiData.data));
        
        // 数据兜底
        cleanData.date = cleanData.date || new Date().toISOString().split('T')[0];
        cleanData.lunar_date = cleanData.lunar_date || '未知';
        cleanData.news = Array.isArray(cleanData.news) ? cleanData.news.filter(n => n && n.trim()) : [];
        cleanData.tip = cleanData.tip || '暂无微语';

        return cleanData;
      } catch (err) {
        retries--;
        if (retries === 0) throw err;
        console.log(`API重试(${3 - retries}/3)：`, err.message);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  try {
    // 1. 获取API数据
    const apiData = await fetch60sData();
    console.log(`✅ 获取数据：${apiData.date}，新闻数=${apiData.news.length}`);

    // 2. 生成图片
    const imageBase64 = await generateImage(apiData);
    const imageBuffer = Buffer.from(imageBase64.split(',')[1], 'base64');
    const fileName = `${apiData.date}.png`;

    // 3. 上传到GitHub
    await uploadToGitHub(fileName, imageBuffer);
    console.log(`✅ 上传成功：${REPO_CONFIG.path}${fileName}`);

  } catch (err) {
    console.error('❌ 执行失败：', err.message);
    process.exit(1);
  }
}

/**
 * 生成图片（增加页面截图调试）
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
        '--disable-features=IsolateOrigins,site-per-process',
        '--font-render-hinting=full' // 强制字体渲染
      ],
      headless: 'new',
      defaultViewport: { 
        width: 1000,  // 适配Banner宽度
        height: 3000,
        deviceScaleFactor: 2 // 高清渲染
      },
      timeout: 120000
    });

    const page = await browser.newPage();

    // 捕获页面日志
    page.on('console', msg => console.log(`[页面${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => console.error(`[页面错误] ${err.message}`));

    // 加载模板
    const templatePath = path.resolve(process.cwd(), 'src/template.html');
    await page.goto(`file://${templatePath}`, { waitUntil: 'domcontentloaded' });

    // 注入数据
    await page.evaluate(dataStr => {
      window.DATA = JSON.parse(dataStr);
    }, JSON.stringify(data));

    // 触发绘制
    await page.evaluate(async () => {
      if (typeof generate === 'function') await generate();
      else throw new Error('generate函数不存在');
    });

    // 调试：截取页面全屏截图（本地运行可查看渲染效果）
    // await page.screenshot({ path: 'debug-render.png', fullPage: true });

    // 等待图片生成
    const imageBase64 = await page.waitForFunction(() => {
      if (window.IMAGE_ERROR) throw new Error(window.IMAGE_ERROR);
      return window.IMAGE_BASE64;
    }, { timeout: 180000 });

    return imageBase64.jsonValue();

  } catch (err) {
    throw new Error(`图片生成失败：${err.message}`);
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * 上传到GitHub
 */
async function uploadToGitHub(fileName, fileBuffer) {
  const filePath = `${REPO_CONFIG.path}${fileName}`;
  try {
    const existingFile = await octokit.rest.repos.getContent({
      owner: REPO_CONFIG.owner,
      repo: REPO_CONFIG.repo,
      path: filePath,
      ref: REPO_CONFIG.branch
    }).catch(() => null);

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
    throw new Error(`GitHub上传失败：${err.message}`);
  }
}

// 执行
update60s();
