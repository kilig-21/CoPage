package com.school.collab.document;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.ot.Delta;
import java.util.List;
import java.util.Map;

/** 内置公共空白框架，不读取或复用任何用户文档。每次返回独立 Delta。 */
public final class DocumentTemplates {
    private DocumentTemplates() { }

    public static List<TemplateView> list() {
        return List.of(
            template("meeting", "会议纪要", "collaboration", "记录议题、讨论结论和后续行动。", new Delta()
                .insert("会议纪要").insert("\n", Map.of("header", 1))
                .insert("会议主题：\n日期：\n参会人员：\n\n")
                .insert("议题与讨论").insert("\n", Map.of("header", 2))
                .insert("议题：\n讨论要点：\n\n")
                .insert("决定与行动").insert("\n", Map.of("header", 2))
                .insert("行动事项 / 负责人 / 截止日期\n")),
            template("project", "项目计划", "planning", "整理目标、工作安排与验收标准。", new Delta()
                .insert("项目计划").insert("\n", Map.of("header", 1))
                .insert("项目名称：\n负责人：\n起止日期：\n\n")
                .insert("目标与范围").insert("\n", Map.of("header", 2))
                .insert("目标：\n交付内容：\n\n")
                .insert("工作安排").insert("\n", Map.of("header", 2))
                .insert("任务 / 负责人 / 完成时间\n\n")
                .insert("验收与风险").insert("\n", Map.of("header", 2))
                .insert("验收标准：\n风险与处理：\n")),
            template("notes", "学习笔记", "learning", "记录知识要点、例子和待解决问题。", new Delta()
                .insert("学习笔记").insert("\n", Map.of("header", 1))
                .insert("主题：\n日期：\n参考资料：\n\n")
                .insert("知识要点").insert("\n", Map.of("header", 2))
                .insert("要点一\n要点二\n\n")
                .insert("例子与练习").insert("\n", Map.of("header", 2))
                .insert("记录例子或练习过程。\n\n")
                .insert("问题与下一步").insert("\n", Map.of("header", 2))
                .insert("待解决问题：\n下一步：\n")),
            template("weekly", "工作周报", "collaboration", "汇总本周进展、待解决问题与下周安排。", new Delta()
                .insert("工作周报").insert("\n", Map.of("header", 1))
                .insert("汇报人：\n周期：\n\n")
                .insert("本周进展").insert("\n", Map.of("header", 2))
                .insert("完成事项 / 结果 / 相关资料\n\n")
                .insert("问题与支持").insert("\n", Map.of("header", 2))
                .insert("遇到的问题：\n需要的支持：\n\n")
                .insert("下周安排").insert("\n", Map.of("header", 2))
                .insert("计划事项 / 预期结果 / 完成时间\n")),
            template("requirements", "需求说明", "planning", "明确使用场景、功能范围与验收条件。", new Delta()
                .insert("需求说明").insert("\n", Map.of("header", 1))
                .insert("需求名称：\n负责人：\n日期：\n\n")
                .insert("背景与使用场景").insert("\n", Map.of("header", 2))
                .insert("使用者：\n要解决的问题：\n使用流程：\n\n")
                .insert("功能与范围").insert("\n", Map.of("header", 2))
                .insert("需要支持：\n本次不包含：\n\n")
                .insert("验收条件").insert("\n", Map.of("header", 2))
                .insert("操作步骤 / 预期结果\n待确认问题：\n")),
            template("retrospective", "项目复盘", "learning", "回顾结果、提炼经验并确定改进动作。", new Delta()
                .insert("项目复盘").insert("\n", Map.of("header", 1))
                .insert("项目名称：\n复盘日期：\n参与人员：\n\n")
                .insert("目标与结果").insert("\n", Map.of("header", 2))
                .insert("原定目标：\n实际结果：\n\n")
                .insert("经验与问题").insert("\n", Map.of("header", 2))
                .insert("做得好的：\n可以改进的：\n原因与经验：\n\n")
                .insert("改进动作").insert("\n", Map.of("header", 2))
                .insert("行动 / 负责人 / 完成时间 / 验证方式\n"))
        );
    }

    public static TemplateView require(String id) {
        return list().stream().filter(t -> t.id().equals(id)).findFirst()
            .orElseThrow(() -> new BizException(ErrorCode.PARAM_ERROR, "模板不存在，请重新选择"));
    }

    private static TemplateView template(String id, String title, String category, String description, Delta content) {
        return new TemplateView(id, title, category, description, content);
    }

    public record TemplateView(String id, String title, String category, String description, Delta content) { }
}
