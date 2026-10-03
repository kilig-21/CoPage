import { useEffect, useState } from 'react'
import { FileTextOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { Avatar, Button, Card, Empty, Input, Layout, List, Modal, Popconfirm, Space, Typography, message } from 'antd'
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

  useEffect(() => {
    let active = true
    setLoading(true)
    request.get('/doc/list', { params: { page, size: PAGE_SIZE } })
      .then((response) => {
        if (!active) return
        setDocs(response.data.list)
        setTotal(response.data.total)
      })
      .catch((error) => {
        if (active) message.error(error?.message || '文档列表加载失败')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [page, refresh])

  async function createDocument() {
    try {
      const response = await request.post('/doc', { title: '未命名文档' })
      navigate('/docs/' + response.data.id)
    } catch (error) {
      message.error(error?.message || '创建文档失败')
    }
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
          <Avatar>{(localStorage.getItem('collab-user') || 'A').slice(0, 1).toUpperCase()}</Avatar>
          <Button type="text" onClick={logout}>退出</Button>
        </Space>
      </header>
      <main className="content-wrap">
        <div className="page-heading">
          <div><Typography.Title level={2}>我的文档</Typography.Title><Typography.Text type="secondary">所有修改都会自动保存</Typography.Text></div>
          <Space wrap>
            <Button onClick={() => navigate('/templates')}>从模板新建</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={createDocument}>新建文档</Button>
          </Space>
        </div>
        <Card className="doc-list-card">
          <List
            loading={loading}
            dataSource={docs}
            locale={{ emptyText: <Empty description="还没有文档，先新建一篇吧" /> }}
            pagination={total > PAGE_SIZE ? { current: page, pageSize: PAGE_SIZE, total, onChange: setPage } : false}
            renderItem={(doc) => (
              <List.Item actions={[
                <Link key="open" to={'/docs/' + doc.id}>打开</Link>,
                doc.permission === 2 && <Button key="rename" type="link" onClick={() => { setEditing(doc); setTitle(doc.title) }}>重命名</Button>,
                doc.isOwner && <Button key="members" type="link" onClick={() => setManaging(doc)}>协作者管理</Button>,
                doc.isOwner && <Popconfirm key="delete" title="确定删除这篇文档吗？" onConfirm={() => deleteDocument(doc.id)}>
                  <Button type="link" danger>删除</Button>
                </Popconfirm>,
              ].filter(Boolean)}>
                <List.Item.Meta avatar={<FileTextOutlined className="doc-icon" />} title={doc.title} description={doc.ownerName + ' · ' + doc.updateTime} />
              </List.Item>
            )}
          />
        </Card>
      </main>
      {managing && <CollaboratorModal doc={managing} onClose={() => setManaging(null)} />}
      <Modal title="重命名文档" open={Boolean(editing)} onOk={renameDocument} onCancel={() => setEditing(null)}>
        <Input maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} onPressEnter={renameDocument} />
      </Modal>
    </Layout>
  )
}
