const joi = require("joi");

// 基础规则定义
const username = joi.string().min(2).max(10).messages({
  "string.min": "昵称最少需要2个字符",
  "string.max": "昵称最多10个字符",
});

const avatar = joi.string().uri().allow("").messages({
  "string.uri": "头像地址格式不正确",
});

const email = joi.string().email().messages({
  "string.email": "邮箱格式不正确",
});

exports.profile = {
  body: joi
    .object({
      data: joi
        .object({
          username: username.optional(), // 设为可选，这样不改名字时不会报错
          avatar: avatar.optional(), // 必须在这里定义，否则会被 stripUnknown 删掉
          email: email.optional(), // 修正：之前你这里写的是 gender
        })
        .required(),
    })
    .unknown(true),
};

// 发送邮箱验证码规则
// 🔒 2026-10-12 修复（api.md P1-1）：stripUnknown 会剥掉 data 内/顶层未定义字段
//    （含客户端可能塞入的 userId），与控制器 `req.userId` 归一形成双层防护。
exports.emailSendCode = {
  body: joi
    .object({
      data: joi
        .object({
          email: joi.string().email().messages({
            "string.email": "邮箱格式不正确",
          }),
          type: joi.string().valid("email", "pwd").default("email"),
        })
        .required(),
    })
    .unknown(true),
};

// 修改邮箱验证规则
exports.emailChange = {
  body: joi
    .object({
      data: joi
        .object({
          email: joi.string().email().required().messages({
            "string.email": "邮箱格式不正确",
            "any.required": "邮箱不能为空",
          }),
          code: joi.string().length(6).required().messages({
            "string.length": "验证码必须是6位",
            "any.required": "验证码不能为空",
          }),
        })
        .required(),
    })
    .unknown(true),
};

// 修改密码验证规则（需要邮箱验证码）
exports.passwordChangeWithCode = {
  body: joi
    .object({
      data: joi
        .object({
          oldPassword: joi.string().min(6).required().messages({
            "string.min": "密码至少6位",
            "any.required": "旧密码不能为空",
          }),
          newPassword: joi.string().min(6).required().messages({
            "string.min": "密码至少6位",
            "any.required": "新密码不能为空",
          }),
          code: joi.string().length(6).required().messages({
            "string.length": "验证码必须是6位",
            "any.required": "验证码不能为空",
          })
        })
        .required(),
    })
    .unknown(true),
};
