import { Button, Collapse, Drawer, Typography } from 'antd'

const { Paragraph, Text } = Typography
const sections = [
  {
    key: 'start', label: '开始一篇文档',
    children: <>
      <ol>
        <li>在登录页选择“没有账号？注册”，完成后使用新账号登录。</li>
        <li>在“我的文档”点击“新建文档”；也可以“从模板新建”，预览会议纪要、项目计划或学习笔记后命名并创建。</li>
        <li>等待编辑页显示“已连接”，输入正文；结束编辑前确认“所有修改已保存”。</li>
      </ol>
      <Paragraph>已有内容可以从文档列表的“导入文档”创建一篇独立文档。</Paragraph>
    </>,
  },
  {
    key: 'collaborate', label: '邀请同伴与访问权限',
    children: <>
      <ol>
        <li>请同伴先注册账号，并告诉你用于登录的用户名。</li>
        <li>文档所有者打开“协作者管理”，按用户名添加成员，选择“只读”或“可编辑”。</li>
        <li>在编辑页打开“分享链接”，复制链接交给同伴；对方登录后即可按已授予的权限打开。</li>
      </ol>
      <Paragraph>分享链接不会自动授予权限。“与我协作”显示别人共享给你的文档；只读成员可以阅读、查看历史、导出或创建自己的副本。</Paragraph>
      <Paragraph>文档权限控制正文访问。当前图片通过公开可读取的地址展示，能读取图片地址的人仍可查看图片；上传前请确认图片适合这样展示。</Paragraph>
    </>,
  },
  {
    key: 'save', label: '连接、保存与无法输入',
    children: <>
      <Paragraph><Text strong>“已连接”</Text>表示协作连接就绪；<Text strong>“所有修改已保存”</Text>表示当前正文没有等待确认的修改。正在保存或上传时，请等对应操作完成。</Paragraph>
      <Paragraph>只读、加载/同步、断线或登录失效时会暂停编辑，请按页面提示处理。网络恢复后会尝试自动重连；未确认内容会作为此浏览器、此账号的本地草稿保留。</Paragraph>
      <Paragraph>查找文档可从列表“搜索”进入，按标题或正文关键词检索；列表的标题筛选只筛选当前分类。关闭指南后，编辑页的“文档内查找”或 Ctrl/⌘+F 可查找当前正文，可编辑成员还可以替换。</Paragraph>
      <Paragraph>创建、导入或恢复出现“结果未确认”时，先按提示核对列表或最新版本，再决定是否重试。</Paragraph>
    </>,
  },
  {
    key: 'draft', label: '本地草稿与内容备份',
    children: <>
      <Paragraph>刷新后出现“发现未确认的本地编辑”，先查看草稿，必要时下载富文本或纯文本副本。具备编辑权限时，可明确选择“恢复草稿并同步”；也可以“稍后处理”。</Paragraph>
      <Paragraph>本地草稿属于当前浏览器和原账号，不会自动跟随你到另一台电脑。换账号后，需用原账号登录才能继续处理原草稿。</Paragraph>
      <Paragraph>只读、撤权或文档已删除时，可先保存本地副本；下载副本不会恢复原权限。浏览器无法保存草稿而显示临时备份页时，请先下载或复制完整正文，再刷新或关闭页面。</Paragraph>
      <Paragraph>只有确认不再需要这份内容时，才选择“丢弃本地草稿”。</Paragraph>
    </>,
  },
  {
    key: 'history', label: '历史版本与误删找回',
    children: <>
      <Paragraph>“历史版本”可以查看已保存内容。所有者可以标记重要版本或恢复指定内容；恢复会生成新的版本，并同步给在线协作者。</Paragraph>
      <Paragraph>恢复前等待当前修改保存、连接恢复及上传完成。如果提示文档已有新编辑，重新核对最新版本后再决定恢复。</Paragraph>
      <Paragraph>普通历史自动清理默认关闭。出现“清理过期历史”时，先核对范围；确认后，范围外的普通旧版本将无法恢复，重要版本继续保留。</Paragraph>
      <Paragraph>列表“删除”会将文档移入回收站并停止协作者访问。所有者可在“回收站”恢复文档，正文、版本与原成员权限会保留。</Paragraph>
    </>,
  },
  {
    key: 'transfer', label: '副本、导入导出与打印',
    children: <>
      <Paragraph>“创建副本”复制已保存版本的正文、格式和图片地址，新文档归你；成员权限、历史和当前本地未确认草稿不复制。</Paragraph>
      <Paragraph>导入支持非空 UTF-8 文本（.txt）及 CoPage 导出的富文本副本（.json）。单个导入或导出副本最多 1 MiB；导入创建独立文档，不覆盖已有内容。</Paragraph>
      <Paragraph>导出纯文本便于阅读，富文本副本可重新导入并保留格式。图片保留原地址，不打包图片文件；地址仍可访问时才会显示。</Paragraph>
      <Paragraph>“打印 / PDF”预览已保存内容，再使用浏览器打印或另存为 PDF。资料有未确认修改或图片尚未加载时，请先处理页面提示。</Paragraph>
    </>,
  },
]

export default function UserGuide({ onClose, initialSection = 'start' }) {
  return <Drawer title="CoPage 使用指南" aria-label="CoPage 使用指南" open
    width="min(680px, 100vw)" onClose={onClose}
    footer={<Button type="primary" onClick={onClose}>继续当前操作</Button>}>
    <Paragraph>查看步骤时仍留在当前页面，关闭指南后可继续操作。</Paragraph>
    <Collapse accordion defaultActiveKey={[initialSection]} items={sections} />
  </Drawer>
}
