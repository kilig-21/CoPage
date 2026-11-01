import { Typography } from 'antd'

export default function WorkspacePageHeading({ title, description, children }) {
  return <div className="page-heading">
    <div className="page-heading-copy">
      <Typography.Title level={1}>{title}</Typography.Title>
      {description && <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>}
    </div>
    {children && <div className="page-heading-actions">{children}</div>}
  </div>
}
