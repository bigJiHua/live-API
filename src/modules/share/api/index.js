const express = require("express");
const router = express.Router();
const shareController = require("../controller");
const sharePage = require("../controller/sharePage");

// 公开接口，无需 authGuard
// API 托管的分享详情页（SSR，零 JS）：?token=… / ?id=…；
// 密码表单 POST 提交到根路径 /share/diary/detail（app.js 注册，避开 securityCheck 头校验）
router.get("/diary/detail", sharePage.view);
router.get("/:token", shareController.viewShare);
router.post("/password", shareController.verifyPassword);

module.exports = router;
