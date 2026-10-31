// Мотивация аутсорса: настройки, люди из актов, расчёт часов по норме.
import { req } from './core.js'

const jsonBody = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export async function saveMotivationSettings(settings) {
  return req('/api/motivation/settings', jsonBody('PUT', settings))
}

export async function addMotivationPeople({ date, shift, receivedAt, fromStats = false, people }) {
  return req('/api/motivation/people', jsonBody('POST', { date, shift, receivedAt, fromStats, people }))
}

export async function updateMotivationPerson(id, patch) {
  return req(`/api/motivation/people/${id}`, jsonBody('PUT', patch))
}

export async function deleteMotivationPerson(id) {
  return req(`/api/motivation/people/${id}`, { method: 'DELETE' })
}

export async function getMotivationCalculation(date, shift) {
  return req(`/api/motivation/calculate?${new URLSearchParams({ date, shift })}`)
}
