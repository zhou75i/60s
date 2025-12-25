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
  // 获取API数据（带重试+详细日志）
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
        
        // 强制序列化+反序列化，排除不可序列化内容
        const cleanData = JSON.parse(JSON.stringify(apiData.data));
        
        // 校验并修复核心数据（关键：确保news是数组）
        if (!cleanData) throw new Error('API返回data为空');
        if (!cleanData.date) cleanData.date = new Date().toISOString().split('T')[0];
        cleanData.news = Array.isArray(cleanData.news) ? cleanData.news : [];
        cleanData.lunar_date = cleanData.lunar_date || '未知';
        cleanData.tip = cleanData.tip || '暂无微语';

        // 打印API原始数据（调试用）
        console.log('API返回的cleanData：', JSON.stringify(cleanData, null, 2));
        console.log(`✅ API数据校验完成：日期=${cleanData.date}，新闻数=${cleanData.news.length}，微语=${cleanData.tip}`);

        if (cleanData.news.length === 0 && retries > 0) {
          throw new Error('API返回news为空，重试...');
        }
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

    // 3. 上传到GitHub
    await uploadToGitHub(fileName, imageBuffer);
    console.log(`✅ 成功上传图片到GitHub：${REPO_CONFIG.path}${fileName}`);

  } catch (err) {
    console.error('❌ 执行失败：', err.message);
    process.exit(1);
  }
}

/**
 * 生成图片（核心：修复数据注入+详细调试）
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

    // 捕获页面所有日志
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

    // 强制序列化数据（避免Puppeteer注入异常）
    const injectDataStr = JSON.stringify(data);
    console.log('准备注入页面的数据：', injectDataStr);

    // 注入数据（分两步：先传字符串，再解析，避免直接传对象丢失）
    console.log('注入数据到页面...');
    await page.evaluate((dataStr) => {
      window.DATA_RAW = dataStr;
      window.DATA = JSON.parse(dataStr); // 页面内解析，确保结构完整
      console.log('页面接收的DATA：', JSON.stringify(window.DATA, null, 2));
    }, injectDataStr);

    // 触发绘制（等待异步完成）
    console.log('触发页面绘制...');
    await page.evaluate(async () => {
      if (typeof generate === 'function') {
        await generate();
      } else {
        throw new Error('页面未找到generate函数');
      }
    });

    // 等待图片生成
    console.log('等待图片生成...');
    const imageBase64 = await page.waitForFunction(() => {
      if (window.IMAGE_ERROR) throw new Error(window.IMAGE_ERROR);
      return window.IMAGE_BASE64;
    }, { 
      timeout: 180000,
      polling: 1000
    });

    // 调试信息
    const canvasInfo = await page.evaluate(() => {
      return {
        base64Length: window.IMAGE_BASE64.length,
        dataNewsLength: window.DATA.news.length,
        error: window.IMAGE_ERROR || '无'
      };
    });
    console.log(`图片生成完成，Base64长度：${canvasInfo.base64Length}，页面内新闻数：${canvasInfo.dataNewsLength}`);

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
