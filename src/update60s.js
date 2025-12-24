import { storage, type SavedData } from './services/storage';
import {
  debug,
  formatSavedData,
  getInputArgValue,
  isValidDateFormat,
  localeDate,
  localeTime,
  log,
} from './utils';
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
update60s().catch(error => {
  console.error('执行失败:', error);
  process.exit(1);
});

export async function update60s(): Promise<void> {
  const inputDate = getInputArgValue('date');
  debug('inputDate', inputDate || '[空]');

  // 校验日期格式
  if (inputDate && !isValidDateFormat(inputDate)) {
    console.error('日期格式错误，需为：YYYY-MM-DD');
    process.exit(1);
  }
  const date = inputDate || localeDate();
  debug('目标日期', date);

  // 检查GitHub是否已存在图片
  const isImageExist = await checkGitHubImage(date);
  if (storage.hasData(date) && isImageExist) {
    log(`[${date}] 数据和图片已存在，跳过`);
    process.exit(0);
  }

  // 仅生成图片（已有数据）
  if (storage.hasData(date)) {
    const data = await storage.loadData(date);
    if (!data) {
      console.warn(`[${date}] 无数据`);
      process.exit(1);
    }
    log(`[${date}] 存在数据，生成图片...`);
    await saveImage(data);
    process.exit(0);
  }

  // ========== 核心修改：从API获取数据 ==========
  log(`[${date}] 从API获取数据...`);
  let apiData;
  try {
    const response = await fetch(API_URL, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
    }

    apiData = await response.json();
    debug('API返回数据', apiData);

    // 校验API返回数据结构
    if (!apiData.data || !apiData.data.date || !apiData.data.news) {
      throw new Error('API返回数据结构异常，缺少核心字段');
    }

    // 校验日期匹配（API返回的是当日数据）
    const apiDate = apiData.data.date;
    if (inputDate && apiDate !== date) {
      throw new Error(`API返回日期(${apiDate})与请求日期(${date})不匹配`);
    }

  } catch (err) {
    console.error('获取API数据失败:', err);
    process.exit(1);
  }

  // 组装SavedData格式数据
  const now = Date.now();
  const data: SavedData = {
    date: apiData.data.date,
    news: apiData.data.news || [],
    tip: apiData.data.tip || '',
    lunar_date: apiData.data.lunar_date || '',
    image: `https://cdn.jsdmirror.com/gh/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}@${REPO_CONFIG.branch}/${REPO_CONFIG.path}${apiData.data.date}.png`,
    cover: apiData.data.cover || '',
    link: apiData.data.link || '',
    created: localeTime(now),
    created_at: now,
    updated: localeTime(now),
    updated_at: now,
  };

  debug('组装后的数据', data);

  // 保存数据+生成上传图片
  await storage.saveData(data);
  await saveImage(data);
  log('执行完成');
}

/**
 * 检查GitHub是否存在指定日期的图片
 */
async function checkGitHubImage(date: string): Promise<boolean> {
  try {
    await octokit.rest.repos.getContent({
      owner: REPO_CONFIG.owner,
      repo: REPO_CONFIG.repo,
      path: `${REPO_CONFIG.path}${date}.png`,
      ref: REPO_CONFIG.branch
    });
    return true;
  } catch (err: any) {
    return err.status !== 404;
  }
}

/**
 * 生成图片并上传到GitHub
 */
async function saveImage(data: SavedData): Promise<void> {
  let browser;
  try {
    // 启动无头浏览器
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    // 加载模板并注入数据
    const page = await browser.newPage();
    const templatePath = path.resolve(__dirname, 'template.html');
    const templateHtml = fs.readFileSync(templatePath, 'utf8');
    await page.setContent(templateHtml, { waitUntil: 'domcontentloaded' });
    await page.evaluate(injectData => window.DATA = injectData, data);

    // 等待图片生成（超时30秒）
    const imageBase64 = await page.waitForFunction(() => {
      return window.IMAGE_BASE64 || window.IMAGE_ERROR;
    }, { timeout: 30000 }).then(async handle => {
      const res = await handle.jsonValue();
      if (res === window.IMAGE_ERROR) throw new Error(`生成失败: ${res}`);
      return res;
    });

    // Base64转Buffer
    const buffer = Buffer.from(imageBase64.split(',')[1], 'base64');

    // 上传到GitHub
    const fileName = `${data.date}.png`;
    let sha;
    // 检查文件是否存在（存在则需要sha更新）
    try {
      const existing = await octokit.rest.repos.getContent({
        owner: REPO_CONFIG.owner,
        repo: REPO_CONFIG.repo,
        path: `${REPO_CONFIG.path}${fileName}`,
        ref: REPO_CONFIG.branch
      });
      // @ts-ignore
      sha = existing.data.sha;
    } catch (err: any) {
      if (err.status !== 404) throw new Error(`获取文件信息失败: ${err.message}`);
    }

    // 上传/更新文件
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: REPO_CONFIG.owner,
      repo: REPO_CONFIG.repo,
      path: `${REPO_CONFIG.path}${fileName}`,
      message: `Auto generate 60s image: ${fileName}`,
      content: buffer.toString('base64'),
      branch: REPO_CONFIG.branch,
      ...(sha ? { sha } : {})
    });

    log(`图片已上传: ${REPO_CONFIG.path}${fileName}`);
  } catch (err) {
    console.error('生成/上传失败:', err);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}
