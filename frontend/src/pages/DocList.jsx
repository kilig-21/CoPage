import { useEffect, useState } from 'react'
import { FileTextOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Avatar, Button, Card, Empty, Input, Layout, List, Modal, Pagination, Popconfirm, Space, Typography, message } from 'antd'
import { Link, useNavigate } from 'react-router-dom'
import request from '../api/request'
import CollaboratorModal from '../components/CollaboratorModal'

const PAGE_SIZE = 20

export default function DocList() {
  const [managing, setManaging] = useState(null)
  const navigate = useNavigate()
  const [docs, setDocs] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(null)
  const [title, setTitle] = useState('')
  const [loadError, setLoadError] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    request.get('/doc/list', { params: { page, size: PAGE_SIZE }, signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return
        const lastPage = Math.max(1, Math.ceil(response.data.total / PAGE_SIZE))
        if (page > lastPage) { setPage(lastPage); return }
        setDocs(response.data.list)
        setTotal(response.data.total)
      })
      .catch((error) => {
        if (!controller.signal.aborted) { setDocs([]); setLoadError(error?.message || '文档列表加载失败') }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [page, refresh])

  async function createDocument() {
    if (creating) return
    setCreating(true)
    try {
      const response = await request.post('/doc', { title: '未命名文档' })
      navigate('/docs/' + response.data.id)
    } catch (error) {
      message.error(error?.message || '创建文档失败')
    } finally { setCreating(false) }
  }

  async function renameDocument() {
    if (!title.trim()) {
      message.warning('请输入文档标题')
      return
    }
    try {
      await request.put('/doc/' + editing.id, { title: title.trim() })
      setEditing(null)
      setRefresh((value) => value + 1)
    } catch (error) {
      message.error(error?.message || '重命名失败')
    }
  }

  async function deleteDocument(id) {
    try {
      await request.delete('/doc/' + id)
      setRefresh((value) => value + 1)
    } catch (error) {
      message.error(error?.message || '删除失败')
    }
  }

  function logout() {
    localStorage.removeItem('collab-token')
    localStorage.removeItem('collab-user')
    navigate('/login', { replace: true })
  }

  return (
    <Layout className="app-shell">
      <header className="topbar">
        <Typography.Title level={4}>协同文档</Typography.Title>
        <Space>
          <Button icon={<SearchOutlined />} onClick={() => navigate('/search')}>搜索</Button>
          <Button onClick={() => navigate('/trash')}>回收站</Button>
          <Avatar>{(localStorage.getItem('collab-user') || 'A').slice(0, 1).toUpperCase()}</Avatar>
          <Button type="text" onClick={logout}>退出</Button>
        </Space>
      </header>
      <main className="content-wrap">
        <div className="page-heading">
          <div><Typography.Title level={2}>我的文档</Typography.Title><Typography.Text type="secondary">编辑时可查看连接与保存状态，删除的文档可从回收站找回</Typography.Text></div>
          <Space wrap>
            <Button onClick={() => navigate('/templates')}>从模板新建</Button>
            <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={createDocument}>新建文档</Button>
          </Space>
        </div>
        <Card className="doc-list-card">
          {loadError && <Alert type="error" showIcon message={loadError}
            action={<Button disabled={loading} onClick={() => setRefresh(value => value + 1)}>重试</Button>} />}
          <List
            loading={loading}
            dataSource={docs}
            locale={{ emptyText: loading ? '正在加载…' : loadError ? '列表暂不可用' : <Empty description="还没有文档，先新建一篇吧" /> }}
            renderItem={(doc) => (
              <List.Item actions={[
                <Link key="open" to={'/docs/' + doc.id}>打开</Link>,
                doc.permission === 2 && <Button key="rename" type="link" onClick={() => { setEditing(doc); setTitle(doc.title) }}>重命名</Button>,
                doc.isOwner && <Button key="members" type="link" onClick={() => setManaging(doc)}>协作者管理</Button>,
                doc.isOwner && <Popconfirm key="delete" title="将这篇文档移入回收站？" description="协作者将停止访问，你可以在回收站恢复。" onConfirm={() => deleteDocument(doc.id)}>
                  <Button type="link" danger>删除</Button>
                </Popconfirm>,
              ].filter(Boolean)}>
                <List.Item.Meta avatar={<FileTextOutlined className="doc-icon" />} title={doc.title} description={doc.ownerName + ' · ' + doc.updateTime} />
              </List.Item>
            )}
          />
          {total > PAGE_SIZE && <Pagination current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false}
            disabled={loading} onChange={setPage} />}
        </Card>
      </main>
      {managing && <CollaboratorModal doc={managing} onClose={() => setManaging(null)} />}
      <Modal title="重命名文档" open={Boolean(editing)} onOk={renameDocument} onCancel={() => setEditing(null)}>
        <Input maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} onPressEnter={renameDocument} />
      </Modal>
    </Layout>
  )
}
