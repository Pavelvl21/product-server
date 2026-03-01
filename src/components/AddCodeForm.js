import React, { useState } from 'react';
import { Form, Button, InputGroup, Alert } from 'react-bootstrap';
import { FaPlus, FaTrash, FaCrosshairs } from 'react-icons/fa';
import axios from 'axios';

const AddCodeForm = ({ onCodeAdded, onCodeDeleted, secretKey }) => {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleCodeChange = (e) => {
    const value = e.target.value.replace(/[^\d]/g, '');
    setCode(value);
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!code) {
      setError('Введите код товара');
      return;
    }

    if (code.length > 12) {
      setError('Код не может быть длиннее 12 цифр');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const response = await axios.post(
        'https://product-server-k38t.onrender.com/api/codes',
        { code },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-secret-key': secretKey
          }
        }
      );

      setSuccess(`Код ${code} добавлен в базу Price Hunter!`);
      setCode('');
      onCodeAdded();
      
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      if (err.response?.status === 403) {
        setError('Ошибка авторизации. Проверьте секретный ключ.');
      } else if (err.response?.data?.error) {
        setError(err.response.data.error);
      } else {
        setError('Ошибка при добавлении кода');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!code) {
      setError('Введите код товара для удаления');
      return;
    }

    if (!window.confirm(`Удалить товар с кодом ${code} из Price Hunter?`)) {
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await axios.delete(
        `https://product-server-k38t.onrender.com/api/codes/${code}`,
        {
          headers: {
            'x-secret-key': secretKey
          }
        }
      );

      setSuccess(`Код ${code} удален из базы`);
      setCode('');
      onCodeDeleted();
      
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      if (err.response?.status === 403) {
        setError('Ошибка авторизации. Проверьте секретный ключ.');
      } else if (err.response?.status === 404) {
        setError('Код не найден');
      } else {
        setError('Ошибка при удалении кода');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="add-code-form">
      <h5 className="mb-3">
        <FaCrosshairs className="me-2" />
        Охота за новыми товарами
      </h5>
      <Form onSubmit={handleSubmit}>
        <InputGroup className="mb-3">
          <Form.Control
            type="text"
            placeholder="Введите код товара (только цифры)"
            value={code}
            onChange={handleCodeChange}
            disabled={loading}
            maxLength={12}
          />
          <Button 
            variant="primary" 
            type="submit" 
            disabled={loading}
            className="btn-hunter"
          >
            <FaPlus className="me-2" />
            Выследить
          </Button>
          <Button 
            variant="danger" 
            onClick={handleDelete}
            disabled={loading}
          >
            <FaTrash className="me-2" />
            Удалить
          </Button>
        </InputGroup>
        
        {error && <Alert variant="danger">{error}</Alert>}
        {success && <Alert variant="success">{success}</Alert>}
        
        <Form.Text className="text-muted">
          🔍 Код должен содержать только цифры (до 12 символов). 
          Добавленные товары появятся в таблице после обновления.
        </Form.Text>
      </Form>
    </div>
  );
};

export default AddCodeForm;
