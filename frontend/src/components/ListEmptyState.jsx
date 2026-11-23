import { FileTextOutlined } from '@ant-design/icons'

export default function ListEmptyState({ description, children }) {
  return <div className="cp-list-empty">
    <span className="cp-list-empty-icon" aria-hidden="true"><FileTextOutlined /></span>
    <p>{description}</p>
    {children}
  </div>
}
