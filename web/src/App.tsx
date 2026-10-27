import type * as React from 'react'
import { useEffect, useState } from 'react'
import {
  Shield, LayoutDashboard, Users, MapPin,
  Route, AlertTriangle, CalendarDays,
  Settings, Menu, X, Activity, Clock,
  CheckCircle2, Search, Bell
} from 'lucide-react'
import './App.css'

const menu = [
  { name: 'Обзор', icon: LayoutDashboard },
  { name: 'Сотрудники', icon: Users },
  { name: 'Объекты', icon: MapPin },
  { name: 'Патрули', icon: Route },
  { name: 'Происшествия', icon: AlertTriangle },
  { name: 'Смены', icon: CalendarDays },
  { name: 'Настройки', icon: Settings },
]

const guards = [
  { name: 'Александр Иванов', site: 'Объект №1', status: 'На смене' },
  { name: 'Михаил Петров', site: 'Объект №2', status: 'На патруле' },
  { name: 'Дмитрий Соколов', site: 'Объект №3', status: 'На смене' },
  { name: 'Андрей Волков', site: 'Объект №1', status: 'Не на смене' },
]

const incidents = [
  { title: 'Проверка территории', site: 'Объект №1', time: '09:15', status: 'Завершено' },
  { title: 'Нарушение пропускного режима', site: 'Объект №2', time: '10:42', status: 'Открыто' },
  { title: 'Плановый обход', site: 'Объект №3', time: '11:30', status: 'Завершено' },
]


type Site = {
  id: number
  name: string
  address: string | null
}

function SitesManager() {
  const [sites, setSites] = useState<Site[]>([])
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const loadSites = async () => {
    try {
      const response = await fetch('http://127.0.0.1:3001/api/sites')
      if (!response.ok) throw new Error('Ошибка сервера')
      const data: Site[] = await response.json()
      setSites(data)
      setError('')
    } catch {
      setError('Не удалось подключиться к серверу')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadSites()
  }, [])

  const addSite = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!name.trim() || saving) return

    setSaving(true)
    setError('')

    try {
      const response = await fetch('http://127.0.0.1:3001/api/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), address: address.trim() })
      })

      if (!response.ok) throw new Error('Ошибка сохранения')

      setName('')
      setAddress('')
      await loadSites()
    } catch {
      setError('Не удалось сохранить объект')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <form onSubmit={addSite} style={{
        display: 'grid',
        gap: 12,
        marginBottom: 24
      }}>
        <h3>Добавить объект</h3>

        <input
          placeholder="Название объекта"
          value={name}
          onChange={e => setName(e.target.value)}
          required
          maxLength={120}
        />

        <input
          placeholder="Адрес объекта"
          value={address}
          onChange={e => setAddress(e.target.value)}
          maxLength={200}
        />

        <button type="submit" disabled={saving}>
          {saving ? 'Сохранение...' : 'Добавить объект'}
        </button>
      </form>

      {error && <p role="alert" style={{ color: '#f87171' }}>{error}</p>}

      {loading ? (
        <p>Загрузка объектов...</p>
      ) : sites.length === 0 ? (
        <p>Объектов пока нет</p>
      ) : (
        <div className="tile-grid">
          {sites.map(site => (
            <div className="tile" key={site.id}>
              <MapPin color="#818cf8" />
              <h3>{site.name}</h3>
              <p>{site.address || 'Адрес не указан'}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function App() {
  const [summary, setSummary] = useState({
    users: 0, sites: 0, shifts: 0,
    patrols: 0, incidents: 0
  })
  const [apiOnline, setApiOnline] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch('http://127.0.0.1:3001/api/summary')
        if (!response.ok) throw new Error('API unavailable')
        setSummary(await response.json())
        setApiOnline(true)
      } catch {
        setApiOnline(false)
      }
    }
    load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [])

  const [page, setPage] = useState('Обзор')
  const [sidebar, setSidebar] = useState(false)
  const [search, setSearch] = useState('')

  const navigate = (name: string) => {
    setPage(name)
    setSidebar(false)
    setSearch('')
  }

  return (
    <div className="app">
      {sidebar && <div className="overlay" onClick={() => setSidebar(false)} />}

      <aside className={`sidebar ${sidebar ? 'opened' : ''}`}>
        <div className="brand">
          <div className="brand-icon"><Shield size={24} /></div>
          <div>
            <strong>PatrolApp</strong>
            <small>DISPATCHER</small>
          </div>
          <button className="close" onClick={() => setSidebar(false)}><X /></button>
        </div>

        <div className="nav-label">УПРАВЛЕНИЕ</div>
        <nav>
          {menu.map(item => {
            const Icon = item.icon
            return (
              <button
                key={item.name}
                className={`nav-item ${page === item.name ? 'active' : ''}`}
                onClick={() => navigate(item.name)}
              >
                <Icon size={19} />
                {item.name}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-bottom">
          <span className="online-dot" />
          {apiOnline ? 'API подключён' : 'API недоступен'}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="top-left">
            <button className="menu-button" onClick={() => setSidebar(true)}>
              <Menu size={23} />
            </button>
            <div>
              <h1>{page}</h1>
              <p>Центр управления охраной</p>
            </div>
          </div>
          <div className="top-actions">
            <span className="demo-tag">DEMO</span>
            <Bell size={20} />
            <div className="avatar">AD</div>
          </div>
        </header>

        <div className="content">
          {page === 'Обзор' && (
            <>
              <div className="welcome">
                <div>
                  <span className="eyebrow">PATROLAPP CONTROL CENTER</span>
                  <h2>Оперативная обстановка</h2>
                  <p>Обзор работы службы охраны и патрулей</p>
                </div>
                <div className="system-status">
                  <Activity size={17} /> Демо-режим
                </div>
              </div>

              <div className="stats">
                {[
                  { label: 'Всего сотрудников', value: String(summary.users), icon: Users, color: 'blue' },
                  { label: 'Всего смен', value: String(summary.shifts), icon: CheckCircle2, color: 'green' },
                  { label: 'Всего патрулей', value: String(summary.patrols), icon: Route, color: 'purple' },
                  { label: 'Происшествия', value: String(summary.incidents), icon: AlertTriangle, color: 'orange' },
                ].map(stat => {
                  const Icon = stat.icon
                  return (
                    <div className="stat-card" key={stat.label}>
                      <div className={`stat-icon ${stat.color}`}><Icon size={22} /></div>
                      <span>{stat.label}</span>
                      <strong>{stat.value}</strong>
                      <small>Демонстрационные данные</small>
                    </div>
                  )
                })}
              </div>

              <div className="columns">
                <section className="panel">
                  <div className="panel-heading">
                    <h3><Users size={19} /> Сотрудники на объектах</h3>
                    <button onClick={() => navigate('Сотрудники')}>Все сотрудники →</button>
                  </div>
                  <GuardList search="" />
                </section>

                <section className="panel">
                  <div className="panel-heading">
                    <h3><Activity size={19} /> Последние события</h3>
                  </div>
                  <IncidentList search="" />
                </section>
              </div>
            </>
          )}

          {page !== 'Обзор' && (
            <>
              <div className="section-intro">
                <h2>{page}</h2>
                <p>Демонстрационный раздел системы PatrolApp</p>
              </div>

              {(page === 'Сотрудники' || page === 'Происшествия') && (
                <div className="search-box">
                  <Search size={19} />
                  <input
                    placeholder="Поиск..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                </div>
              )}

              <section className="panel full-panel">
                {page === 'Сотрудники' ? (
                  <GuardList search={search} />
                ) : page === 'Происшествия' ? (
                  <IncidentList search={search} />
                ) : page === 'Объекты' ? (
          <SitesManager />
        ) : page === 'Патрули' ? (
                  <div className="tile-grid">
                    {['Маршрут A', 'Маршрут B', 'Маршрут C'].map(route => (
                      <div className="tile" key={route}>
                        <Route color="#818cf8" />
                        <h3>{route}</h3>
                        <p>Контрольные точки будут подключены через API</p>
                      </div>
                    ))}
                  </div>
                ) : page === 'Смены' ? (
                  <div className="empty">
                    <Clock size={36} />
                    <h3>Расписание смен</h3>
                    <p>Здесь появятся графики сотрудников после подключения сервера.</p>
                  </div>
                ) : (
                  <div className="empty">
                    <Settings size={36} />
                    <h3>Настройки системы</h3>
                    <p>Роли пользователей, безопасность и интеграции будут добавлены позже.</p>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

function GuardList({ search }: { search: string }) {
  const filtered = guards.filter(g =>
    `${g.name} ${g.site} ${g.status}`.toLowerCase().includes(search.toLowerCase())
  )
  return (
    <div className="list">
      {filtered.length === 0 && <p>Ничего не найдено</p>}
      {filtered.map(g => (
        <div className="list-row" key={g.name}>
          <div className="person-avatar">{g.name.split(' ').map(n => n[0]).join('')}</div>
          <div className="list-info">
            <strong>{g.name}</strong>
            <small><MapPin size={12} /> {g.site}</small>
          </div>
          <span className={`status ${g.status === 'Не на смене' ? 'inactive' : ''}`}>
            {g.status}
          </span>
        </div>
      ))}
    </div>
  )
}

function IncidentList({ search }: { search: string }) {
  const filtered = incidents.filter(i =>
    `${i.title} ${i.site} ${i.status}`.toLowerCase().includes(search.toLowerCase())
  )
  return (
    <div className="list">
      {filtered.length === 0 && <p>Ничего не найдено</p>}
      {filtered.map(i => (
        <div className="list-row" key={i.title}>
          <div className="event-icon"><AlertTriangle size={18} /></div>
          <div className="list-info">
            <strong>{i.title}</strong>
            <small><Clock size={12} /> {i.time} · {i.site}</small>
          </div>
          <span className={`status ${i.status === 'Открыто' ? 'warning' : ''}`}>
            {i.status}
          </span>
        </div>
      ))}
    </div>
  )
}

export default App
