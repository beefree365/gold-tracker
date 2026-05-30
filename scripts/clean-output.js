#!/usr/bin/env node

/**
 * 清理 output 文件夹及相关临时文件
 * 用法: node scripts/clean-output.js
 */

const fs = require('fs');
const path = require('path');

// 项目根目录
const ROOT_DIR = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');

// 需要清理的目录列表
const CLEANUP_DIRS = [
    OUTPUT_DIR,
    path.join(ROOT_DIR, 'temp'),
    path.join(ROOT_DIR, '.temp'),
];

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
};

function log(message, color = colors.reset) {
    console.log(`${color}${message}${colors.reset}`);
}

/**
 * 递归删除文件夹内容
 */
function cleanDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        log(`⚠️  目录不存在: ${dirPath}`, colors.yellow);
        return { deleted: 0, size: 0 };
    }

    let deletedCount = 0;
    let totalSize = 0;

    try {
        const files = fs.readdirSync(dirPath);
        
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = fs.statSync(filePath);
            
            if (stats.isDirectory()) {
                // 递归删除子目录
                const result = cleanDirectory(filePath);
                deletedCount += result.deleted;
                totalSize += result.size;
                
                // 删除空目录
                try {
                    fs.rmdirSync(filePath);
                    deletedCount++;
                    log(`  📁 删除目录: ${file}`, colors.blue);
                } catch (err) {
                    log(`  ⚠️  无法删除目录: ${file} - ${err.message}`, colors.yellow);
                }
            } else {
                // 删除文件
                const fileSize = stats.size;
                totalSize += fileSize;
                
                try {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
                    log(`  🗑️  删除文件: ${file} (${sizeMB} MB)`, colors.green);
                } catch (err) {
                    log(`  ⚠️  无法删除文件: ${file} - ${err.message}`, colors.yellow);
                }
            }
        }
    } catch (err) {
        log(`❌ 错误: 无法读取目录 ${dirPath} - ${err.message}`, colors.red);
    }

    return { deleted: deletedCount, size: totalSize };
}

/**
 * 格式化文件大小
 */
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 主函数
 */
function main() {
    log('\n🧹 开始清理 output 文件夹及相关临时文件...\n', colors.blue);
    
    let totalDeleted = 0;
    let totalSize = 0;

    CLEANUP_DIRS.forEach(dir => {
        log(`\n📂 清理目录: ${path.relative(ROOT_DIR, dir)}`, colors.blue);
        const result = cleanDirectory(dir);
        totalDeleted += result.deleted;
        totalSize += result.size;
        
        if (result.deleted > 0) {
            log(`  ✅ 已删除 ${result.deleted} 个文件/文件夹，释放 ${formatSize(result.size)}`, colors.green);
        } else {
            log(`  ℹ️  目录为空或不存在`, colors.yellow);
        }
    });

    log('\n' + '='.repeat(60), colors.blue);
    log(`📊 清理完成统计:`, colors.blue);
    log(`   - 删除文件/文件夹总数: ${totalDeleted}`, colors.green);
    log(`   - 释放空间: ${formatSize(totalSize)}`, colors.green);
    log('='.repeat(60) + '\n', colors.blue);
}

// 执行清理
main();
